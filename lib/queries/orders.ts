import type { Pool } from "pg";

export type OrderRow = {
  id: number;
  external_ref: string | null;
  source: string;
  status: string;
  line_count: number;
  created_at: string;
};

export async function listOrders(pool: Pool): Promise<OrderRow[]> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT id, external_ref, source, status, line_count,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
     FROM orders
     ORDER BY created_at DESC
     LIMIT 200`
  );
  return rows;
}

export async function ordersCountByStatus(
  pool: Pool
): Promise<{ status: string; count: number }[]> {
  const { rows } = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::bigint AS count
     FROM orders
     GROUP BY status
     ORDER BY count DESC`
  );
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}
