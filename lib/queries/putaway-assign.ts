import type { Pool } from "pg";

export type PutawayScope = "all_colors" | "single_color_all_sizes";

/**
 * Move RFID items to a bin by scanned custom SKU.
 *
 * The mobile app strips the size before sending, so `skuScanned` is expected
 * to be matrix+color (e.g. `1125444B8` non-legacy / `C11111001C7` legacy) for
 * `single_color_all_sizes`, and the full custom SKU for `all_colors` is fine
 * because we resolve the matrix from any child SKU.
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

  // Multi-bin policy: only place items that are currently homeless
  // (bin_id IS NULL). Items already in another bin are left alone, which lets
  // the same SKU naturally split across multiple bins as new EPCs are
  // commissioned over time. To rebin items already in a bin, the operator
  // uses the explicit Clean / Remove flow first.
  if (scope === "single_color_all_sizes") {
    // Place homeless items whose custom SKU starts with the scanned prefix
    // (mobile app sends matrix+color prefix — all sizes match).
    const r = await pool.query(
      `UPDATE items SET bin_id = $1::uuid
       WHERE location_id = $2::uuid
         AND bin_id IS NULL
         AND custom_sku_id IN (
           SELECT id FROM custom_skus WHERE sku LIKE $3
         )`,
      [binId, locationId, `${trimmed}%`],
    );
    return { updated: r.rowCount ?? 0 };
  }

  // all_colors — resolve matrix from exact SKU match, then place every
  // homeless item belonging to that matrix regardless of color/size.
  const skuRow = await pool.query<{ matrix_id: string }>(
    `SELECT matrix_id::text FROM custom_skus WHERE sku = $1 LIMIT 1`,
    [trimmed],
  );
  const matrixId = skuRow.rows[0]?.matrix_id;
  if (!matrixId) return { updated: 0 };

  const r = await pool.query(
    `UPDATE items SET bin_id = $1::uuid
     WHERE location_id = $2::uuid
       AND bin_id IS NULL
       AND custom_sku_id IN (
         SELECT id FROM custom_skus WHERE matrix_id = $3::uuid
       )`,
    [binId, locationId, matrixId],
  );
  return { updated: r.rowCount ?? 0 };
}
