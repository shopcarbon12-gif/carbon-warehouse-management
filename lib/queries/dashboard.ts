import type { Pool } from "pg";

export type DashboardKpis = {
  inventory_units: number;
  order_open: number;
  exceptions_open: number;
  sync_pending: number;
};

export async function getDashboardKpis(
  pool: Pool,
  tenantId: string,
  locationId: string,
): Promise<DashboardKpis> {
  const inv = await pool.query<{ c: string }>(
    `SELECT coalesce(sum(qty), 0)::text AS c
     FROM inventory_items
     WHERE location_id = $1::uuid`,
    [locationId],
  );
  const ord = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM orders
     WHERE tenant_id = $1::uuid
       AND location_id = $2::uuid
       AND status NOT IN ('shipped', 'cancelled')`,
    [tenantId, locationId],
  );
  const exc = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM exceptions
     WHERE tenant_id = $1::uuid
       AND location_id = $2::uuid
       AND state NOT IN ('resolved', 'ignored')`,
    [tenantId, locationId],
  );
  const sync = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM sync_jobs
     WHERE tenant_id = $1::uuid
       AND (location_id IS NULL OR location_id = $2::uuid)
       AND status IN ('queued', 'running', 'failed')`,
    [tenantId, locationId],
  );
  return {
    inventory_units: Number(inv.rows[0]?.c ?? 0),
    order_open: Number(ord.rows[0]?.c ?? 0),
    exceptions_open: Number(exc.rows[0]?.c ?? 0),
    sync_pending: Number(sync.rows[0]?.c ?? 0),
  };
}
