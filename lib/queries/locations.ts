import type { Pool } from "pg";

export type LocationRow = { id: string; code: string; name: string };

export type BinWithCountRow = {
  id: string;
  code: string;
  capacity: number | null;
  in_stock_count: number;
  status: string;
};

/** Line items grouped by custom SKU for a bin drawer (in-stock EPCs only). */
export type BinContentLineRow = {
  custom_sku_id: string;
  description: string;
  sku: string;
  color_code: string | null;
  size: string | null;
  qty: number;
};

export async function listLocationsForTenant(
  pool: Pool,
  tenantId: string,
): Promise<LocationRow[]> {
  const r = await pool.query<LocationRow>(
    `SELECT id, code, name FROM locations
     WHERE tenant_id = $1::uuid
     ORDER BY code ASC`,
    [tenantId],
  );
  return r.rows;
}

/** All bins at `locationId` with in-stock EPC counts (LEFT JOIN items). */
export async function listBinsWithCounts(
  pool: Pool,
  locationId: string,
): Promise<BinWithCountRow[]> {
  const r = await pool.query<{
    id: string;
    code: string;
    capacity: string | null;
    in_stock_count: string;
    status: string;
  }>(
    `SELECT
       b.id,
       b.code,
       b.capacity::text AS capacity,
       b.status,
       COUNT(i.id) FILTER (WHERE i.status = 'in-stock')::text AS in_stock_count
     FROM bins b
     LEFT JOIN items i
       ON i.bin_id = b.id
       AND i.location_id = $1::uuid
     WHERE b.location_id = $1::uuid
       AND b.archived_at IS NULL
     GROUP BY b.id, b.code, b.capacity, b.status
     ORDER BY b.code ASC`,
    [locationId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    code: row.code,
    capacity: row.capacity != null ? Number(row.capacity) : null,
    in_stock_count: Number(row.in_stock_count),
    status: row.status,
  }));
}

/** Matrix descriptions / custom SKUs in a bin at the location, aggregated for mixed-bin display. */
export async function listBinContentsGrouped(
  pool: Pool,
  locationId: string,
  binId: string,
): Promise<BinContentLineRow[]> {
  const r = await pool.query<{
    custom_sku_id: string;
    description: string;
    sku: string;
    color_code: string | null;
    size: string | null;
    qty: string;
  }>(
    `SELECT
       cs.id AS custom_sku_id,
       m.description,
       cs.sku,
       cs.color_code,
       cs.size,
       COUNT(i.id)::text AS qty
     FROM items i
     INNER JOIN bins bin ON bin.id = i.bin_id AND bin.location_id = $2::uuid AND bin.archived_at IS NULL
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     INNER JOIN matrices m ON m.id = cs.matrix_id
     WHERE i.bin_id = $1::uuid
       AND i.location_id = $2::uuid
       AND i.status = 'in-stock'
     GROUP BY cs.id, m.id, m.description, cs.sku, cs.color_code, cs.size
     ORDER BY m.description ASC, cs.sku ASC`,
    [binId, locationId],
  );
  return r.rows.map((row) => ({
    custom_sku_id: row.custom_sku_id,
    description: row.description,
    sku: row.sku,
    color_code: row.color_code,
    size: row.size,
    qty: Number(row.qty),
  }));
}
