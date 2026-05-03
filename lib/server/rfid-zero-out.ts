import type { PoolClient } from "pg";

/**
 * Tables wiped by the operator-driven "zero out RFID data" action.
 *
 * What's IN the wipe (RFID/tag/quantity-derived data):
 *   - items                 commissioned EPC ↔ SKU bindings (= every tag the system knows about)
 *   - cdm_reads             raw reader stream
 *   - device_epc_queue      pending tag-to-server queue
 *   - asset_movements       tag-derived zone transitions
 *   - rfid_alarms           tag-driven alarm events
 *   - handheld_batches      handheld scan batches
 *   - transfer_items        transfer line-items (carry EPC FKs into items)
 *   - compare_lines         in-progress cycle-count comparison rows
 *   - inventory_items       tag-aggregated inventory snapshot rows
 *
 * What stays (logs, history, reports, catalog, infra, auth):
 *   audit_log, inventory_audit_logs, inventory_reports, external_system_logs,
 *   device_upload_logs, replenishment_logs, exceptions, compare_runs,
 *   encode_events (history of every tag-encode operation — it's a record
 *   of who-encoded-what-when, not "RFID data" in the operator sense),
 *   matrices, custom_skus, status_labels, users, locations, zones, bins,
 *   devices, cdm_agents, antenna_profiles, tenant_settings, etc.
 *
 * Each table needs its own tenant-scoping clause because not every table
 * carries a `tenant_id` column directly — most reach the tenant through a
 * parent FK (location, device, slip, run). The first version of this code
 * assumed `tenant_id` was universal; the very first table on the list
 * (`transfer_items`) doesn't have it, so the action died with "column
 * tenant_id does not exist" before doing anything.
 *
 * Order matters: child tables before parent tables to satisfy FK
 * constraints (compare_lines before compare_runs, transfer_items before
 * transfer_slips/transfer_records, items deletes are last).
 */
type TableSpec = {
  name: string;
  /** WHERE clause body. `$1` is bound to the tenant uuid. */
  whereClause: string;
};

const ZERO_OUT_SPECS: ReadonlyArray<TableSpec> = [
  {
    name: "transfer_items",
    // transfer_items.slip_number is integer; transfer_records.slip_number
    // is bigint while transfer_slips.slip_number is integer. Cast both
    // sides to bigint to avoid "operator does not exist: integer = bigint"
    // on the IN.
    whereClause: `slip_number::bigint IN (
      SELECT slip_number::bigint FROM transfer_slips WHERE tenant_id = $1::uuid
      UNION
      SELECT slip_number::bigint FROM transfer_records WHERE tenant_id = $1::uuid
    )`,
  },
  {
    name: "compare_lines",
    // compare_lines.compare_run_id → compare_runs.location_id → locations.tenant_id.
    // (compare_runs doesn't carry tenant_id directly — it scopes by location.)
    whereClause: `compare_run_id IN (
      SELECT id FROM compare_runs
       WHERE location_id IN (SELECT id FROM locations WHERE tenant_id = $1::uuid)
    )`,
  },
  {
    name: "asset_movements",
    whereClause: `tenant_id = $1::uuid`,
  },
  {
    name: "rfid_alarms",
    whereClause: `tenant_id = $1::uuid`,
  },
  {
    name: "handheld_batches",
    // handheld_batches.location_id → locations.tenant_id.
    whereClause: `location_id IN (SELECT id FROM locations WHERE tenant_id = $1::uuid)`,
  },
  {
    name: "device_epc_queue",
    whereClause: `tenant_id = $1::uuid`,
  },
  {
    name: "inventory_items",
    whereClause: `location_id IN (SELECT id FROM locations WHERE tenant_id = $1::uuid)`,
  },
  {
    name: "cdm_reads",
    whereClause: `tenant_id = $1::uuid`,
  },
  {
    name: "items",
    whereClause: `location_id IN (SELECT id FROM locations WHERE tenant_id = $1::uuid)`,
  },
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

  // Hard transaction guards. Verified live against the prod schema with a
  // dry-run + rollback on 2026-05-03 — without these the chain deadlocked
  // against the live cdm-agent posting cdm_reads at ~30 rows/s.
  //   - lock_timeout: fail fast if a row is contested (avoid long hangs)
  //   - statement_timeout: hard ceiling on any single DELETE
  //   - session_replication_role='replica': disables FK-trigger checks for
  //     the duration of THIS transaction, so cascading FK locks don't
  //     collide with the agent's concurrent INSERTs. Reverts at COMMIT/
  //     ROLLBACK because we used SET LOCAL.
  await client.query(`SET LOCAL lock_timeout = '10s'`);
  await client.query(`SET LOCAL statement_timeout = '120s'`);
  await client.query(`SET LOCAL session_replication_role = 'replica'`);

  const counts: ZeroOutCounts[] = [];
  let totalDeleted = 0;

  for (const spec of ZERO_OUT_SPECS) {
    const exists = await client.query<{ t: string | null }>(
      `SELECT to_regclass($1)::text AS t`,
      [`public.${spec.name}`],
    );
    if (!exists.rows[0]?.t) {
      counts.push({ table: spec.name, before: 0, after: 0, deleted: 0 });
      continue;
    }
    const beforeRes = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.${spec.name} WHERE ${spec.whereClause}`,
      [args.tenantId],
    );
    const before = Number(beforeRes.rows[0]?.n ?? 0);
    const del = await client.query(
      `DELETE FROM public.${spec.name} WHERE ${spec.whereClause}`,
      [args.tenantId],
    );
    const deleted = del.rowCount ?? 0;
    counts.push({ table: spec.name, before, after: before - deleted, deleted });
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
