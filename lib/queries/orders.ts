import type { Pool } from "pg";

export type OrderRow = {
  id: string;
  external_ref: string | null;
  source: string;
  status: string;
  line_count: number;
  created_at: string;
};

type OrderRowDb = {
  id: string;
  external_ref: string | null;
  source: string;
  status: string;
  line_count: number;
  created_at: Date;
};

/** Lists recent orders for the first tenant (dev / single-tenant). */
export async function listOrders(pool: Pool): Promise<OrderRow[]> {
  const r = await pool.query<OrderRowDb>(
    `SELECT o.id, o.external_ref, o.source, o.status, o.line_count, o.created_at
     FROM orders o
     INNER JOIN locations l ON o.location_id = l.id
     INNER JOIN tenants t ON l.tenant_id = t.id
     WHERE t.id = (SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1)
     ORDER BY o.created_at DESC
     LIMIT 100`,
  );

  return r.rows.map((row) => ({
    id: row.id,
    external_ref: row.external_ref,
    source: row.source,
    status: row.status,
    line_count: row.line_count,
    created_at: row.created_at.toISOString(),
  }));
}
