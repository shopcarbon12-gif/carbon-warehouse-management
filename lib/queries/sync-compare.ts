import type { Pool } from "pg";

export type PhysicalSkuRow = {
  sku: string;
  matrix_description: string;
  physical_count: number;
};

/**
 * In-stock EPC rows at the location, rolled up by custom SKU.
 * Join shape: matrices ← custom_skus ← items.
 */
export async function listPhysicalEpcCountsBySku(
  pool: Pool,
  locationId: string,
): Promise<PhysicalSkuRow[]> {
  const r = await pool.query<{
    sku: string;
    matrix_description: string;
    physical_count: string;
  }>(
    `SELECT
       cs.sku,
       m.description AS matrix_description,
       COUNT(i.id)::text AS physical_count
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN items i
       ON i.custom_sku_id = cs.id
       AND i.location_id = $1::uuid
       AND i.status = 'in-stock'
     GROUP BY cs.sku, m.description
     ORDER BY cs.sku ASC`,
    [locationId],
  );
  return r.rows.map((row) => ({
    sku: row.sku,
    matrix_description: row.matrix_description,
    physical_count: Number(row.physical_count),
  }));
}
