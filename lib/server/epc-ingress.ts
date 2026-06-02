import type { PoolClient } from "pg";
import { decodeEpc, type EpcConfig } from "@/lib/server/epc-decode";
import { legacyEpcSystemId, legacyEpcSerial } from "@/lib/server/legacy-epc-catalog";

/**
 * Unified EPC ingress — every EPC entering the WMS (fixed reader, handheld,
 * transfer page, manual entry, cycle count, future module) lands here.
 *
 * Decision tree:
 *   1. Decode the EPC against the tenant's bit layout.
 *      └─ Invalid (wrong length / non-hex / wrong prefix) → status = 'tag_killed'
 *   2. Look up `ls_system_id` against `custom_skus` for this tenant.
 *      └─ No match → status = 'tag_killed'
 *      └─ Match found → status = 'in-stock'
 *   3. INSERT (or UPDATE on epc conflict) the items row.
 *      └─ Sets the decoded serial as `serial_number` (replaces the meaningless
 *         auto-gen number old AUTO-PENDING used to write).
 *      └─ Records source + source_device_label + first_scanned_at.
 *
 * The catalog UI filters out `tag_killed` rows, so defective tags simply
 * don't appear in the main catalog. They only show in the Defective EPCs
 * popup. If a tag flips from `tag_killed` → `in-stock` because the catalog
 * later catches up to its system_id, it auto-disappears from that popup.
 */

export type EpcSource =
  | "fixed_reader"
  | "handheld"
  | "transfer"
  | "manual"
  | "cycle_count"
  | "count_inventory"
  | "count_inventory_override"
  | "add_on_count";

export type EpcIngressInput = {
  /** Tenant the EPC belongs to. Required for catalog lookup + config load. */
  tenantId: string;
  /** Raw EPC hex (case-insensitive, will be uppercased). */
  epc: string;
  /** Where the read came from (audit field, populates Defective EPCs popup). */
  source: EpcSource;
  /** Human-readable device id (e.g. "Antenna bin 1", "H001"). null is allowed. */
  sourceDeviceLabel: string | null;
  /**
   * Structured device attribution. devices.id of the reader / handheld /
   * printer that originated this read. Use resolveHandheldDeviceId() (or
   * pass a fixed-reader UUID directly) to populate. null = not resolved.
   */
  sourceDeviceId?: string | null;
  /**
   * For fixed-reader sources, the antenna sub-device that decoded this EPC.
   * devices.id where device_type='antenna'. null for handhelds (single-radio)
   * and for any path without per-antenna attribution.
   */
  sourceAntennaId?: string | null;
  /** Where the EPC was physically read. Required (NOT NULL on items). */
  locationId: string;
  /** When the read happened (for first_scanned_at + last_seen_at). */
  receivedAt: Date;
};

export type EpcIngressResult = {
  /** items.id of the row that was inserted or updated. null on a no-op. */
  itemId: string | null;
  /** Final status written to items.status. */
  status: "in-stock" | "tag_killed";
  /** When status === 'tag_killed', why. Useful for audit. */
  reason?: "decode_failed" | "unknown_system_id";
  /** custom_skus.id we matched (or null when unmatched / tag-killed). */
  customSkuId: string | null;
  /** Decoded serial that we wrote to items.serial_number. */
  serialNumber: string | null; // bigint stringified for safe JSON
};

// Per-tenant config cache. The brain is small (one row per tenant) and rarely
// changes — caching for 60s avoids slamming the DB during read floods.
type CachedConfig = { config: EpcConfig; expiresAt: number };
const CONFIG_CACHE: Map<string, CachedConfig> = new Map();
const CONFIG_TTL_MS = 60_000;

export async function loadEpcConfig(client: PoolClient, tenantId: string): Promise<EpcConfig | null> {
  const cached = CONFIG_CACHE.get(tenantId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.config;

  const r = await client.query<{
    prefix_hex: string;
    prefix_bits: number;
    asset_bits: number;
    serial_bits: number;
    asset_padding_digits: number;
  }>(
    `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
       FROM tenant_epc_config
      WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  if (r.rowCount === 0 || !r.rows[0]) {
    return null;
  }
  const row = r.rows[0];
  const config: EpcConfig = {
    prefixHex: row.prefix_hex,
    prefixBits: row.prefix_bits,
    assetBits: row.asset_bits,
    serialBits: row.serial_bits,
    assetPaddingDigits: row.asset_padding_digits,
  };
  CONFIG_CACHE.set(tenantId, { config, expiresAt: now + CONFIG_TTL_MS });
  return config;
}

/**
 * Test-only: clear the config cache. Useful in unit tests after editing
 * tenant_epc_config rows. Not exported via index; reach into the module
 * directly if you need it from a test.
 */
export function _clearEpcConfigCacheForTesting(): void {
  CONFIG_CACHE.clear();
}

async function lookupCatalogBySystemId(
  client: PoolClient,
  systemId: bigint,
): Promise<string | null> {
  // custom_skus.ls_system_id is BIGINT; pass as text and cast to avoid
  // JS Number precision issues for values that exceed Number.MAX_SAFE_INTEGER.
  const r = await client.query<{ id: string }>(
    `SELECT id::text FROM custom_skus WHERE ls_system_id = $1::bigint LIMIT 1`,
    [systemId.toString()],
  );
  return r.rowCount && r.rows[0] ? r.rows[0].id : null;
}

/**
 * Attempt the LEGACY catalog-entrance fallback (see lib/server/legacy-epc-catalog).
 * If the legacy system_id resolves to a catalog SKU, write the item LIVE
 * (in-stock) and return the result — the writeItem upsert flips any prior
 * tag_killed row to in-stock, so the EPC leaves the Defective list for good.
 * Returns null when the legacy formula can't place it either (caller then
 * writes tag_killed as usual). NEVER used for encode/print/re-encode.
 */
async function tryLegacyCatalogEntrance(
  client: PoolClient,
  input: EpcIngressInput,
  primarySerial: bigint | null,
): Promise<EpcIngressResult | null> {
  const legacySystemId = legacyEpcSystemId(input.epc);
  if (legacySystemId === null) return null;
  const legacyCustomSkuId = await lookupCatalogBySystemId(client, legacySystemId);
  if (!legacyCustomSkuId) return null;
  return await writeItem(client, input, {
    status: "in-stock",
    customSkuId: legacyCustomSkuId,
    serial: primarySerial ?? legacyEpcSerial(input.epc),
  });
}

/**
 * Ingest a single EPC. Idempotent — second call with the same EPC updates
 * `last_seen_at` and re-evaluates status (which is what powers the auto-flip
 * from `tag_killed` → `in-stock` when the catalog catches up to a system_id).
 *
 * Caller must already be inside a transaction (we use the passed client; we
 * don't BEGIN/COMMIT here so callers can batch many ingests in one txn).
 */
export async function ingestEpc(
  client: PoolClient,
  input: EpcIngressInput,
): Promise<EpcIngressResult> {
  const config = await loadEpcConfig(client, input.tenantId);
  if (!config) {
    // Tenant has no EPC config row — should not happen post-migration 032.
    // Try the legacy fallback before giving up; else tag_killed so the EPC is
    // at least visible in Defective EPCs.
    const legacy = await tryLegacyCatalogEntrance(client, input, null);
    if (legacy) return legacy;
    return await writeItem(client, input, {
      status: "tag_killed",
      reason: "decode_failed",
      customSkuId: null,
      serial: null,
    });
  }

  const decoded = decodeEpc(input.epc, config);
  if (!decoded.valid) {
    // Primary formula rejected it (wrong prefix / bad bits). Legacy fallback:
    // if int(epc[5:15],16) maps to a catalog SKU, bring it in LIVE.
    const legacy = await tryLegacyCatalogEntrance(client, input, null);
    if (legacy) return legacy;
    return await writeItem(client, input, {
      status: "tag_killed",
      reason: "decode_failed",
      customSkuId: null,
      serial: null,
    });
  }

  const customSkuId = await lookupCatalogBySystemId(client, decoded.systemId!);
  if (!customSkuId) {
    // Primary system_id isn't in the catalog. Legacy fallback before tag_killed.
    const legacy = await tryLegacyCatalogEntrance(client, input, decoded.serial);
    if (legacy) return legacy;
    return await writeItem(client, input, {
      status: "tag_killed",
      reason: "unknown_system_id",
      customSkuId: null,
      serial: decoded.serial,
    });
  }

  return await writeItem(client, input, {
    status: "in-stock",
    customSkuId,
    serial: decoded.serial,
  });
}

type WriteItemArgs = {
  status: "in-stock" | "tag_killed";
  reason?: "decode_failed" | "unknown_system_id";
  customSkuId: string | null;
  serial: bigint | null;
};

/**
 * INSERT (or UPDATE on epc conflict) the items row. Centralized so every
 * outcome — live, decode-failed, unknown-system_id — writes the same column
 * set with the same conventions.
 *
 * On conflict (same EPC seen before):
 *   - status is OVERWRITTEN with the new value (powers Scenario A flip)
 *   - serial_number is OVERWRITTEN if newly decoded (was junk before, now real)
 *   - location_id is OVERWRITTEN to the most recent reader's location
 *   - first_scanned_at is PRESERVED (only set on initial insert)
 *   - source / source_device_label are PRESERVED (the original reporter wins)
 *   - last_seen_at is bumped to now
 */
async function writeItem(
  client: PoolClient,
  input: EpcIngressInput,
  args: WriteItemArgs,
): Promise<EpcIngressResult> {
  const epcUpper = input.epc.trim().toUpperCase();
  const serialAsText = args.serial !== null ? args.serial.toString() : "0";

  const r = await client.query<{ id: string }>(
    `INSERT INTO items (
       epc, serial_number, custom_sku_id, location_id,
       status, last_seen_at, first_scanned_at,
       source, source_device_label,
       source_device_id, source_antenna_id
     ) VALUES (
       $1, $2::bigint, $3::uuid, $4::uuid,
       $5, $6::timestamptz, $6::timestamptz,
       $7, $8,
       $9::uuid, $10::uuid
     )
     ON CONFLICT (epc) DO UPDATE SET
       serial_number       = EXCLUDED.serial_number,
       custom_sku_id       = EXCLUDED.custom_sku_id,
       status              = EXCLUDED.status,
       last_seen_at        = EXCLUDED.last_seen_at,
       location_id         = EXCLUDED.location_id,
       first_scanned_at    = COALESCE(items.first_scanned_at, EXCLUDED.first_scanned_at),
       source              = COALESCE(items.source, EXCLUDED.source),
       source_device_label = COALESCE(items.source_device_label, EXCLUDED.source_device_label),
       source_device_id    = COALESCE(items.source_device_id, EXCLUDED.source_device_id),
       source_antenna_id   = COALESCE(items.source_antenna_id, EXCLUDED.source_antenna_id)
     RETURNING id::text`,
    [
      epcUpper,
      serialAsText,
      args.customSkuId,
      input.locationId,
      args.status,
      input.receivedAt.toISOString(),
      input.source,
      input.sourceDeviceLabel,
      input.sourceDeviceId ?? null,
      input.sourceAntennaId ?? null,
    ],
  );

  return {
    itemId: r.rowCount && r.rows[0] ? r.rows[0].id : null,
    status: args.status,
    reason: args.reason,
    customSkuId: args.customSkuId,
    serialNumber: args.serial !== null ? args.serial.toString() : null,
  };
}

/**
 * Convenience: ingest many EPCs in one call (loops over `ingestEpc`).
 * Returns the per-EPC result so the caller can count live vs tag_killed.
 *
 * Intentionally serial — Postgres can't run our INSERT-or-UPDATE concurrently
 * on the same row, and bulk-INSERT-with-decode-per-row would skip the catalog
 * lookup. Read floods are O(reads) anyway; single-call latency is fine.
 */
export async function ingestEpcs(
  client: PoolClient,
  inputs: EpcIngressInput[],
): Promise<EpcIngressResult[]> {
  const out: EpcIngressResult[] = [];
  for (const i of inputs) {
    out.push(await ingestEpc(client, i));
  }
  return out;
}
