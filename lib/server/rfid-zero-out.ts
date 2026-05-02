import type { PoolClient } from "pg";

/**
 * Tables wiped by the operator-driven "zero out RFID data" action.
 *
 * What's IN the wipe (RFID/tag/quantity-derived data):
 *   - items                 commissioned EPC ↔ SKU bindings (= every tag the system knows about)
 *   - cdm_reads             raw reader stream
 *   - device_epc_queue      pending tag-to-server queue
 *   - asset_movements       tag-derived zone transitions
 *   - encode_events         tag-encoding events
 *   - rfid_alarms           tag-driven alarm events
 *   - handheld_batches      handheld scan batches
 *   - transfer_items        transfer line-items (carry EPC FKs into items)
 *   - compare_lines         in-progress cycle-count comparison rows
 *   - inventory_items       tag-aggregated inventory snapshot rows
 *
 * What stays (logs, history, reports, catalog, infra, auth):
 *   audit_log, inventory_audit_logs, inventory_reports, external_system_logs,
 *   device_upload_logs, replenishment_logs, exceptions, compare_runs,
 *   matrices, custom_skus, status_labels, users, locations, zones, bins,
 *   devices, cdm_agents, antenna_profiles, tenant_settings, etc.
 *
 * Order matters: child tables before parent tables to satisfy FK constraints.
 */
const ZERO_OUT_TABLES: ReadonlyArray<string> = [
  "transfer_items",
  "compare_lines",
  "asset_movements",
  "encode_events",
  "rfid_alarms",
  "handheld_batches",
  "device_epc_queue",
  "inventory_items",
  "cdm_reads",
  "items",
];

export type ZeroOutCounts = {
  table: string;
  before: number;
  after: number;
  deleted: number;
};

export type ZeroOutResult = {
  tenant_id: string;
  audit_id: string;
  counts: ZeroOutCounts[];
  total_deleted: number;
};

/**
 * Wipe every RFID-tag row scoped to this tenant. Caller must hold a
 * transaction (BEGIN/COMMIT) so the audit_log row and the deletes are
 * atomic. Tables not present in this database are skipped (returns
 * `before: 0, deleted: 0`) so a misaligned schema doesn't abort the wipe.
 */
export async function zeroOutRfidData(
  client: PoolClient,
  args: { tenantId: string; userId: string; confirmPhrase: string },
): Promise<ZeroOutResult> {
  const expected = "ZERO OUT EVERYTHING";
  if (args.confirmPhrase !== expected) {
    throw new Error(`BAD_REQUEST:Confirmation phrase must be exactly "${expected}".`);
  }

  const counts: ZeroOutCounts[] = [];
  let totalDeleted = 0;

  for (const table of ZERO_OUT_TABLES) {
    const exists = await client.query<{ t: string | null }>(
      `SELECT to_regclass($1)::text AS t`,
      [`public.${table}`],
    );
    if (!exists.rows[0]?.t) {
      counts.push({ table, before: 0, after: 0, deleted: 0 });
      continue;
    }
    const beforeRes = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${table} WHERE tenant_id = $1::uuid`,
      [args.tenantId],
    );
    const before = Number(beforeRes.rows[0]?.n ?? 0);
    const del = await client.query(
      `DELETE FROM public.${table} WHERE tenant_id = $1::uuid`,
      [args.tenantId],
    );
    const deleted = del.rowCount ?? 0;
    counts.push({ table, before, after: before - deleted, deleted });
    totalDeleted += deleted;
  }

  const ins = await client.query<{ id: string }>(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'rfid_zero_out', 'tenant', $3::jsonb)
     RETURNING id::text`,
    [
      args.tenantId,
      args.userId,
      JSON.stringify({
        total_deleted: totalDeleted,
        per_table: counts,
        confirm: args.confirmPhrase,
      }),
    ],
  );

  return {
    tenant_id: args.tenantId,
    audit_id: ins.rows[0]?.id ?? "",
    counts,
    total_deleted: totalDeleted,
  };
}
