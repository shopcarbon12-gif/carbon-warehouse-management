import type { PoolClient } from "pg";
import { decodeEpc } from "@/lib/server/epc-decode";
import { loadEpcConfig } from "@/lib/server/epc-ingress";
import { loadStatusLabelBrainMap } from "@/lib/server/status-label-enforcement";
import { labelNameForWmsStatus } from "@/lib/server/wms-status-to-label-name";

/**
 * Live cycle-count scan ingestion.
 *
 * Unlike epc-ingress.ts (which bulldozes status on UPSERT), this function
 * respects `status_labels.super_admin_locked`. Operators want every read
 * during a cycle count to flow through the formula AND immediately settle
 * inventory state — but tags currently in damaged/sold/stolen/tag_killed/
 * pending_visibility statuses are protected and never auto-transition.
 *
 * Per-EPC outcome (also written to audit_log on every state change):
 *  - live_added         first-time scan, decoded + catalog matched → in-stock
 *  - live_moved         existed in-stock at another location → moved here
 *  - live_revived       existed in unlocked non-in-stock status (return,
 *                       in-transit, pending_transaction) → in-stock at here
 *  - live_already_here  no-op: already in-stock at this location
 *  - defective_decode_fail  decode failed → tag_killed
 *  - defective_no_match     decoded but no catalog hit → tag_killed
 *  - locked            super_admin_locked status; left untouched
 */

export type CycleCountScanOutcome =
  | "live_added"
  | "live_moved"
  | "live_revived"
  | "live_already_here"
  | "defective_decode_fail"
  | "defective_no_match"
  | "locked";

export type CycleCountScanResult = {
  epc: string;
  outcome: CycleCountScanOutcome;
  previous_status: string | null;
  new_status: "in-stock" | "tag_killed" | null;
  from_location_id: string | null;
};

const LOCKED_OUTCOMES = new Set<CycleCountScanOutcome>(["locked"]);

export async function ingestCycleCountEpcs(
  client: PoolClient,
  args: {
    tenantId: string;
    userId: string | null;
    sessionId: string;
    locationId: string;
    epcs: string[];
    receivedAt: Date;
  },
): Promise<CycleCountScanResult[]> {
  const norm = [
    ...new Set(args.epcs.map((e) => e.replace(/\s/g, "").toUpperCase())),
  ].filter((e) => /^[0-9A-F]{24}$/.test(e));
  if (norm.length === 0) return [];

  const config = await loadEpcConfig(client, args.tenantId);
  const labelMap = await loadStatusLabelBrainMap(client);

  // Fetch any existing items rows in one shot.
  const existing = await client.query<{
    id: string;
    epc: string;
    status: string;
    location_id: string;
  }>(
    `SELECT i.id::text, i.epc, i.status, i.location_id::text
       FROM items i
       INNER JOIN locations loc ON loc.id = i.location_id AND loc.tenant_id = $1::uuid
      WHERE i.epc = ANY($2::text[])`,
    [args.tenantId, norm],
  );
  const existingByEpc = new Map<
    string,
    { id: string; status: string; location_id: string }
  >();
  for (const row of existing.rows) {
    existingByEpc.set(row.epc.toUpperCase(), {
      id: row.id,
      status: row.status,
      location_id: row.location_id,
    });
  }

  const results: CycleCountScanResult[] = [];

  for (const epc of norm) {
    const prior = existingByEpc.get(epc) ?? null;

    // 1. Locked statuses are untouchable — no formula, no DB write.
    if (prior) {
      const flags = labelMap.get(labelNameForWmsStatus(prior.status).toLowerCase());
      if (flags?.super_admin_locked) {
        results.push({
          epc,
          outcome: "locked",
          previous_status: prior.status,
          new_status: null,
          from_location_id: prior.location_id,
        });
        continue;
      }
    }

    // 2. Run the formula.
    const decoded = config ? decodeEpc(epc, config) : null;

    if (!decoded || !decoded.valid) {
      const r = await upsertItem(client, {
        epc,
        status: "tag_killed",
        customSkuId: null,
        serial: null,
        locationId: args.locationId,
        receivedAt: args.receivedAt,
      });
      await writeAudit(client, {
        tenantId: args.tenantId,
        userId: args.userId,
        sessionId: args.sessionId,
        epc,
        itemId: r.id,
        previousStatus: prior?.status ?? null,
        newStatus: "tag_killed",
        previousLocationId: prior?.location_id ?? null,
        newLocationId: args.locationId,
        outcome: "defective_decode_fail",
      });
      results.push({
        epc,
        outcome: "defective_decode_fail",
        previous_status: prior?.status ?? null,
        new_status: "tag_killed",
        from_location_id: prior?.location_id ?? null,
      });
      continue;
    }

    const customSkuId = await lookupCatalogBySystemId(client, decoded.systemId!);

    if (!customSkuId) {
      const r = await upsertItem(client, {
        epc,
        status: "tag_killed",
        customSkuId: null,
        serial: decoded.serial,
        locationId: args.locationId,
        receivedAt: args.receivedAt,
      });
      await writeAudit(client, {
        tenantId: args.tenantId,
        userId: args.userId,
        sessionId: args.sessionId,
        epc,
        itemId: r.id,
        previousStatus: prior?.status ?? null,
        newStatus: "tag_killed",
        previousLocationId: prior?.location_id ?? null,
        newLocationId: args.locationId,
        outcome: "defective_no_match",
      });
      results.push({
        epc,
        outcome: "defective_no_match",
        previous_status: prior?.status ?? null,
        new_status: "tag_killed",
        from_location_id: prior?.location_id ?? null,
      });
      continue;
    }

    // 3. Catalog match — write/move to in-stock at this location.
    const outcome: CycleCountScanOutcome = !prior
      ? "live_added"
      : prior.status === "in-stock" && prior.location_id === args.locationId
        ? "live_already_here"
        : prior.status === "in-stock"
          ? "live_moved"
          : "live_revived";

    const r = await upsertItem(client, {
      epc,
      status: "in-stock",
      customSkuId,
      serial: decoded.serial,
      locationId: args.locationId,
      receivedAt: args.receivedAt,
    });

    if (outcome !== "live_already_here") {
      await writeAudit(client, {
        tenantId: args.tenantId,
        userId: args.userId,
        sessionId: args.sessionId,
        epc,
        itemId: r.id,
        previousStatus: prior?.status ?? null,
        newStatus: "in-stock",
        previousLocationId: prior?.location_id ?? null,
        newLocationId: args.locationId,
        outcome,
      });
    }

    results.push({
      epc,
      outcome,
      previous_status: prior?.status ?? null,
      new_status: "in-stock",
      from_location_id: prior?.location_id ?? null,
    });
  }

  return results;
}

/** Exposed for callers that need to know whether to refresh server state. */
export function outcomeChangedDb(outcome: CycleCountScanOutcome): boolean {
  return !LOCKED_OUTCOMES.has(outcome) && outcome !== "live_already_here";
}

async function lookupCatalogBySystemId(
  client: PoolClient,
  systemId: bigint,
): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT id::text FROM custom_skus WHERE ls_system_id = $1::bigint LIMIT 1`,
    [systemId.toString()],
  );
  return r.rowCount && r.rows[0] ? r.rows[0].id : null;
}

async function upsertItem(
  client: PoolClient,
  args: {
    epc: string;
    status: "in-stock" | "tag_killed";
    customSkuId: string | null;
    serial: bigint | null;
    locationId: string;
    receivedAt: Date;
  },
): Promise<{ id: string }> {
  const serialText = args.serial !== null ? args.serial.toString() : "0";
  const r = await client.query<{ id: string }>(
    `INSERT INTO items (
       epc, serial_number, custom_sku_id, location_id,
       status, last_seen_at, first_scanned_at,
       source, source_device_label
     ) VALUES (
       $1, $2::bigint, $3::uuid, $4::uuid,
       $5, $6::timestamptz, $6::timestamptz,
       'cycle_count', 'cycle-count-live'
     )
     ON CONFLICT (epc) DO UPDATE SET
       serial_number    = EXCLUDED.serial_number,
       custom_sku_id    = EXCLUDED.custom_sku_id,
       status           = EXCLUDED.status,
       location_id      = EXCLUDED.location_id,
       last_seen_at     = EXCLUDED.last_seen_at,
       first_scanned_at = COALESCE(items.first_scanned_at, EXCLUDED.first_scanned_at)
     RETURNING id::text`,
    [
      args.epc,
      serialText,
      args.customSkuId,
      args.locationId,
      args.status,
      args.receivedAt.toISOString(),
    ],
  );
  return { id: r.rows[0]!.id };
}

async function writeAudit(
  client: PoolClient,
  args: {
    tenantId: string;
    userId: string | null;
    sessionId: string;
    epc: string;
    itemId: string;
    previousStatus: string | null;
    newStatus: "in-stock" | "tag_killed";
    previousLocationId: string | null;
    newLocationId: string;
    outcome: CycleCountScanOutcome;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'item_live_transition', 'items', $3::jsonb)`,
    [
      args.tenantId,
      args.userId,
      JSON.stringify({
        epc: args.epc,
        item_id: args.itemId,
        previous_status: args.previousStatus,
        new_status: args.newStatus,
        from_location_id: args.previousLocationId,
        to_location_id: args.newLocationId,
        outcome: args.outcome,
        cycle_count_session_id: args.sessionId,
        scanned_at: new Date().toISOString(),
      }),
    ],
  );
}
