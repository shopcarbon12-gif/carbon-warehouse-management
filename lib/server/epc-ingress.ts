import type { PoolClient } from "pg";
import { decodeEpc, type EpcConfig } from "@/lib/server/epc-decode";
import { legacyEpcSystemId, legacyEpcSerial } from "@/lib/server/legacy-epc-catalog";
import {
  loadStatusLabelBrainMap,
  shouldGhostDropLabel,
} from "@/lib/server/status-label-enforcement";
import { labelNameForWmsStatus } from "@/lib/server/wms-status-to-label-name";

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
  /** users.id behind the scan, for the STATUS_CHANGE audit row. */
  auditUserId?: string | null;
  /** Free text for the STATUS_CHANGE audit row (module / session). */
  auditReason?: string | null;
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
  /**
   * Scan rule (owner, 2026-10-13): the tag already exists with a status a scan
   * may not change. Nothing was written; `status` above is meaningless — read
   * `kept.status` (the tag's current status). `ghost` = its status label is set
   * to "Ignore" on the Statuses page (scanners ignore the read entirely).
   */
  kept?: { status: string; ghost: boolean };
};

/**
 * Sources that are SCANS: a read here may only bring an 'unknown' tag, or a
 * brand-new tag that decodes to a catalog SKU, to LIVE — it never changes any
 * other status, and tags whose status is ghosted ("Ignore" on the Statuses
 * page) are ignored outright. Owner rule, 2026-10-13. 'transfer' (receiving
 * slip EPCs that have no row yet) and 'manual' keep their own behaviour.
 */
const SCAN_SOURCES: ReadonlySet<EpcSource> = new Set<EpcSource>([
  "fixed_reader",
  "handheld",
  "cycle_count",
  "count_inventory",
  "count_inventory_override",
  "add_on_count",
]);

export function isScanSource(source: EpcSource): boolean {
  return SCAN_SOURCES.has(source);
}

type PriorItem = { status: string; customSkuId: string | null };

/** Per-batch state: each EPC's current row + the ghost rule, loaded once. */
export type EpcIngressContext = {
  prior: Map<string, PriorItem>;
  isGhost: (status: string) => boolean;
};

/**
 * Lock + load the current rows for [epcs] and the Statuses-page ghost flags.
 * FOR UPDATE so a concurrent ingest of the same EPC can't slip a status change
 * between this read and the write.
 */
export async function loadEpcIngressContext(
  client: PoolClient,
  epcs: string[],
): Promise<EpcIngressContext> {
  const upper = [...new Set(epcs.map((e) => e.trim().toUpperCase()))];
  const prior = new Map<string, PriorItem>();
  if (upper.length > 0) {
    const r = await client.query<{ epc: string; status: string; custom_sku_id: string | null }>(
      `SELECT epc, status, custom_sku_id::text FROM items WHERE epc = ANY($1::text[]) FOR UPDATE`,
      [upper],
    );
    for (const row of r.rows) {
      prior.set(row.epc.toUpperCase(), { status: row.status, customSkuId: row.custom_sku_id });
    }
  }
  const labels = await loadStatusLabelBrainMap(client);
  const isGhost = (status: string) =>
    shouldGhostDropLabel(labels.get(labelNameForWmsStatus(status).trim().toLowerCase()));
  return { prior, isGhost };
}

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
  prior: PriorItem | null,
): Promise<EpcIngressResult | null> {
  const legacySystemId = legacyEpcSystemId(input.epc);
  if (legacySystemId === null) return null;
  const legacyCustomSkuId = await lookupCatalogBySystemId(client, legacySystemId);
  if (!legacyCustomSkuId) return null;
  return await writeItem(client, input, prior, {
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
  ctx?: EpcIngressContext,
): Promise<EpcIngressResult> {
  const c = ctx ?? (await loadEpcIngressContext(client, [input.epc]));
  const prior = c.prior.get(input.epc.trim().toUpperCase()) ?? null;

  // Scan rule: an existing tag whose status is not LIVE or UNKNOWN is left
  // exactly as it is — ghosted statuses are ignored outright, and nothing a
  // scan reads can move sold / return / in-transit / pending / damaged /
  // stolen / killed tags.
  if (prior && isScanSource(input.source) && prior.status !== "in-stock" && prior.status !== "unknown") {
    return {
      itemId: null,
      status: "tag_killed",
      customSkuId: prior.customSkuId,
      serialNumber: null,
      kept: { status: prior.status, ghost: c.isGhost(prior.status) },
    };
  }

  const config = await loadEpcConfig(client, input.tenantId);
  if (!config) {
    // Tenant has no EPC config row — should not happen post-migration 032.
    // Try the legacy fallback before giving up; else tag_killed so the EPC is
    // at least visible in Defective EPCs.
    const legacy = await tryLegacyCatalogEntrance(client, input, null, prior);
    if (legacy) return legacy;
    return await writeItem(client, input, prior, {
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
    const legacy = await tryLegacyCatalogEntrance(client, input, null, prior);
    if (legacy) return legacy;
    return await writeItem(client, input, prior, {
      status: "tag_killed",
      reason: "decode_failed",
      customSkuId: null,
      serial: null,
    });
  }

  const customSkuId = await lookupCatalogBySystemId(client, decoded.systemId!);
  if (!customSkuId) {
    // Primary system_id isn't in the catalog. Legacy fallback before tag_killed.
    const legacy = await tryLegacyCatalogEntrance(client, input, decoded.serial, prior);
    if (legacy) return legacy;
    return await writeItem(client, input, prior, {
      status: "tag_killed",
      reason: "unknown_system_id",
      customSkuId: null,
      serial: decoded.serial,
    });
  }

  return await writeItem(client, input, prior, {
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
  prior: PriorItem | null,
  args: WriteItemArgs,
): Promise<EpcIngressResult> {
  const epcUpper = input.epc.trim().toUpperCase();
  const serialAsText = args.serial !== null ? args.serial.toString() : "0";

  // Status this write lands on. Scans reaching here only see LIVE / UNKNOWN /
  // brand-new tags (everything else returned `kept` in ingestEpc): a tag that
  // already exists is never turned into a defective by a read that fails to
  // decode — it keeps its status, SKU and serial and only its last-seen /
  // location move. Non-scan sources keep the long-standing rule that a killed,
  // damaged or stolen tag is never revived here.
  let finalStatus: string = args.status;
  let keepIdentity = false;
  if (prior) {
    if (isScanSource(input.source)) {
      if (args.status !== "in-stock") {
        finalStatus = prior.status;
        keepIdentity = true;
      }
    } else if (
      (prior.status === "tag_killed" || prior.status === "damaged" || prior.status === "stolen") &&
      args.status === "in-stock"
    ) {
      finalStatus = prior.status;
    }
  }

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
       serial_number       = CASE WHEN $11::boolean THEN items.serial_number ELSE EXCLUDED.serial_number END,
       custom_sku_id       = CASE WHEN $11::boolean THEN items.custom_sku_id ELSE EXCLUDED.custom_sku_id END,
       -- A tag written off as destroyed, ruined or gone stays written off. No
       -- amount of re-reading it changes the physical fact, and this upsert is
       -- where every scan module converges — Count, Add-On Catalog, Add-On
       -- Count, the fixed readers — so an unconditional overwrite here is what
       -- silently resurrected 64 killed tags in one day's counting on
       -- 2026-09-02. Only a manual status change or an encode may reverse it.
       --
       -- 'unknown' is deliberately excluded: it means "lost track", and a
       -- stray scan recovering it is exactly what it exists for.
       --
       -- Migration 0089 enforces the same rule at the DB layer for callers
       -- that never come through here; this keeps the intent visible at the
       -- point of the write rather than only in a trigger.
       status              = CASE
                               WHEN items.status IN ('tag_killed','damaged','stolen')
                                    AND EXCLUDED.status = 'in-stock'
                               THEN items.status
                               ELSE EXCLUDED.status
                             END,
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
      finalStatus,
      input.receivedAt.toISOString(),
      input.source,
      input.sourceDeviceLabel,
      input.sourceDeviceId ?? null,
      input.sourceAntennaId ?? null,
      keepIdentity,
    ],
  );

  // Record the BEFORE status whenever a scan / ingest actually changes one, so
  // "who flipped this tag, and from what?" is always answerable.
  if (prior && prior.status !== finalStatus) {
    await client.query(
      `INSERT INTO inventory_audit_logs (
         tenant_id, log_type, entity_type, entity_reference, old_value, new_value,
         reason, user_id, user_uuid, device_id
       ) VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, $3, $4, $5, NULL, $6::uuid, $7)`,
      [
        input.tenantId,
        epcUpper,
        prior.status,
        finalStatus,
        (input.auditReason ?? `scan: ${input.source}`).slice(0, 500),
        input.auditUserId ?? null,
        input.sourceDeviceLabel,
      ],
    );
  }

  const itemId = r.rowCount && r.rows[0] ? r.rows[0].id : null;
  if (keepIdentity && prior && prior.status !== "in-stock") {
    // An existing non-LIVE tag the read could not decode: untouched status.
    return {
      itemId,
      status: "tag_killed",
      customSkuId: prior.customSkuId,
      serialNumber: null,
      kept: { status: prior.status, ghost: false },
    };
  }
  return {
    itemId,
    status: keepIdentity ? "in-stock" : args.status,
    reason: keepIdentity ? undefined : args.reason,
    customSkuId: keepIdentity ? (prior?.customSkuId ?? null) : args.customSkuId,
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
  if (inputs.length === 0) return out;
  const ctx = await loadEpcIngressContext(
    client,
    inputs.map((i) => i.epc),
  );
  for (const i of inputs) {
    const r = await ingestEpc(client, i, ctx);
    // Later inputs in this batch see this write (same EPC twice in one batch).
    if (!r.kept && r.itemId) {
      ctx.prior.set(i.epc.trim().toUpperCase(), {
        status: r.status,
        customSkuId: r.customSkuId,
      });
    }
    out.push(r);
  }
  return out;
}
