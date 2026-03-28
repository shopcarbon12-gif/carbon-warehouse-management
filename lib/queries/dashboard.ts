import type { Sql } from "@/lib/db";

export type DashboardKpis = {
  inventory_units: number;
  order_open: number;
  exceptions_open: number;
  sync_pending: number;
};

export async function getDashboardKpis(
  sql: Sql,
  tenantId: string,
  locationId: string,
): Promise<DashboardKpis> {
  const [inv] = await sql<{ c: string }[]>`
    SELECT coalesce(sum(qty), 0)::text AS c
    FROM inventory_items
    WHERE location_id = ${locationId}::uuid
  `;
  const [ord] = await sql<{ c: string }[]>`
    SELECT count(*)::text AS c FROM orders
    WHERE tenant_id = ${tenantId}::uuid
      AND location_id = ${locationId}::uuid
      AND status NOT IN ('shipped', 'cancelled')
  `;
  const [exc] = await sql<{ c: string }[]>`
    SELECT count(*)::text AS c FROM exceptions
    WHERE tenant_id = ${tenantId}::uuid
      AND location_id = ${locationId}::uuid
      AND state NOT IN ('resolved', 'ignored')
  `;
  const [sync] = await sql<{ c: string }[]>`
    SELECT count(*)::text AS c FROM sync_jobs
    WHERE tenant_id = ${tenantId}::uuid
      AND (location_id IS NULL OR location_id = ${locationId}::uuid)
      AND status IN ('queued', 'running', 'failed')
  `;
  return {
    inventory_units: Number(inv?.c ?? 0),
    order_open: Number(ord?.c ?? 0),
    exceptions_open: Number(exc?.c ?? 0),
    sync_pending: Number(sync?.c ?? 0),
  };
}
