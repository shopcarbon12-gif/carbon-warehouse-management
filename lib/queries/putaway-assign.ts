import type { Pool } from "pg";

export type PutawayScope = "all_colors" | "single_color";

/**
 * Move RFID items to a bin by scanned custom SKU / matrix grouping.
 */
export async function assignItemsToBinBySkuScan(
  pool: Pool,
  locationId: string,
  binCode: string,
  skuScanned: string,
  scope: PutawayScope,
): Promise<{ updated: number }> {
  const trimmed = skuScanned.trim();
  if (!trimmed) return { updated: 0 };

  const bin = await pool.query<{ id: string }>(
    `SELECT id::text FROM bins WHERE location_id = $1::uuid AND code = $2 LIMIT 1`,
    [locationId, binCode.trim()],
  );
  const binId = bin.rows[0]?.id;
  if (!binId) return { updated: 0 };

  const skuRow = await pool.query<{ id: string; matrix_id: string }>(
    `SELECT id::text, matrix_id::text FROM custom_skus
     WHERE sku = $1 OR sku LIKE $2
     ORDER BY LENGTH(sku) DESC
     LIMIT 1`,
    [trimmed, `${trimmed}%`],
  );
  const match = skuRow.rows[0];
  if (!match) return { updated: 0 };

  if (scope === "single_color") {
    const r = await pool.query(
      `UPDATE items SET bin_id = $1::uuid
       WHERE location_id = $2::uuid AND custom_sku_id = $3::uuid`,
      [binId, locationId, match.id],
    );
    return { updated: r.rowCount ?? 0 };
  }

  const r = await pool.query(
    `UPDATE items SET bin_id = $1::uuid
     WHERE location_id = $2::uuid
       AND custom_sku_id IN (
         SELECT id FROM custom_skus WHERE matrix_id = $3::uuid
       )`,
    [binId, locationId, match.matrix_id],
  );
  return { updated: r.rowCount ?? 0 };
}
