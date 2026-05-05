import type { Pool } from "pg";

export type PutawayScope = "all_colors" | "single_color_all_sizes";

/**
 * Move RFID items to a bin by scanned custom SKU.
 *
 * The mobile app strips the size before sending, so `skuScanned` is expected
 * to be matrix+color (e.g. `1125444B8` non-legacy / `C11111001C7` legacy) for
 * `single_color_all_sizes`, and the full custom SKU for `all_colors` is fine
 * because we resolve the matrix from any child SKU.
 *
 * `mode`:
 *   - `"homeless_only"` (default): only move items that are currently
 *     bin_id IS NULL. Items already in another bin are left alone.
 *   - `"all"`: move every matching item regardless of where it currently
 *     lives. Used by the mobile "MOVE ALL HERE" choice when the operator
 *     resolves the multi-bin prompt.
 */
export async function assignItemsToBinBySkuScan(
  pool: Pool,
  locationId: string,
  binCode: string,
  skuScanned: string,
  scope: PutawayScope,
  mode: "homeless_only" | "all" = "homeless_only",
): Promise<{ updated: number }> {
  const trimmed = skuScanned.trim();
  if (!trimmed) return { updated: 0 };

  const bin = await pool.query<{ id: string }>(
    `SELECT id::text FROM bins WHERE location_id = $1::uuid AND code = $2 LIMIT 1`,
    [locationId, binCode.trim()],
  );
  const binId = bin.rows[0]?.id;
  if (!binId) return { updated: 0 };

  // homeless_only really means "not currently sitting in a LIVE bin." An
  // item whose bin row was archived/deleted is functionally homeless to
  // the operator — the bin doesn't exist anymore in the warehouse — so
  // the assign should pick it up. Pre-1.2.43 we filtered on
  // `bin_id IS NULL` only, which left items pointing at archived bins
  // stranded: the operator scanned them, the assign returned 0, and the
  // dashboard "0 items assigned" snackbar showed up with no clue why.
  const homelessGuard =
    mode === "homeless_only"
      ? `AND (
           bin_id IS NULL
           OR bin_id IN (
             SELECT id FROM bins WHERE archived_at IS NOT NULL
           )
         )`
      : "";

  if (scope === "single_color_all_sizes") {
    // Place items whose custom SKU starts with the scanned prefix
    // (mobile app sends matrix+color prefix — all sizes match).
    const r = await pool.query(
      `UPDATE items SET bin_id = $1::uuid
       WHERE location_id = $2::uuid
         ${homelessGuard}
         AND status IN ('in-stock', 'pending_visibility')
         AND custom_sku_id IN (
           SELECT id FROM custom_skus WHERE sku LIKE $3
         )`,
      [binId, locationId, `${trimmed}%`],
    );
    return { updated: r.rowCount ?? 0 };
  }

  // all_colors — resolve matrix from exact SKU match, then place every
  // item belonging to that matrix regardless of color/size.
  const skuRow = await pool.query<{ matrix_id: string }>(
    `SELECT matrix_id::text FROM custom_skus WHERE sku = $1 LIMIT 1`,
    [trimmed],
  );
  const matrixId = skuRow.rows[0]?.matrix_id;
  if (!matrixId) return { updated: 0 };

  const r = await pool.query(
    `UPDATE items SET bin_id = $1::uuid
     WHERE location_id = $2::uuid
       ${homelessGuard}
       AND status IN ('in-stock', 'pending_visibility')
       AND custom_sku_id IN (
         SELECT id FROM custom_skus WHERE matrix_id = $3::uuid
       )`,
    [binId, locationId, matrixId],
  );
  return { updated: r.rowCount ?? 0 };
}

export type PutawayPreview = {
  homeless: number;
  inThisBin: number;
  inOtherBins: { binCode: string; qty: number }[];
  totalMatching: number;
};

/**
 * Look up how items matching `skuScanned` are distributed: unassigned
 * (homeless), already in this bin, or in some other bin. Used by the
 * mobile assign flow to decide whether to silently move homeless items
 * or to surface a "Move all / Add only homeless / Cancel" prompt when
 * stock is split across bins.
 */
export async function previewPutawayAssign(
  pool: Pool,
  locationId: string,
  binCode: string,
  skuScanned: string,
  scope: PutawayScope,
): Promise<PutawayPreview> {
  const trimmed = skuScanned.trim();
  const empty: PutawayPreview = {
    homeless: 0,
    inThisBin: 0,
    inOtherBins: [],
    totalMatching: 0,
  };
  if (!trimmed) return empty;

  const bin = await pool.query<{ id: string }>(
    `SELECT id::text FROM bins WHERE location_id = $1::uuid AND code = $2 LIMIT 1`,
    [locationId, binCode.trim()],
  );
  const targetBinId = bin.rows[0]?.id ?? null;

  let skuFilter: string;
  let skuParam: string;
  if (scope === "single_color_all_sizes") {
    skuFilter = `custom_sku_id IN (SELECT id FROM custom_skus WHERE sku LIKE $2)`;
    skuParam = `${trimmed}%`;
  } else {
    const skuRow = await pool.query<{ matrix_id: string }>(
      `SELECT matrix_id::text FROM custom_skus WHERE sku = $1 LIMIT 1`,
      [trimmed],
    );
    const matrixId = skuRow.rows[0]?.matrix_id;
    if (!matrixId) return empty;
    skuFilter = `custom_sku_id IN (SELECT id FROM custom_skus WHERE matrix_id = $2::uuid)`;
    skuParam = matrixId;
  }

  const groups = await pool.query<{
    bin_id: string | null;
    bin_code: string | null;
    qty: string;
  }>(
    `SELECT i.bin_id::text AS bin_id,
            b.code AS bin_code,
            COUNT(i.id)::text AS qty
     FROM items i
     LEFT JOIN bins b ON b.id = i.bin_id AND b.archived_at IS NULL
     WHERE i.location_id = $1::uuid
       AND i.status IN ('in-stock', 'pending_visibility')
       AND i.${skuFilter}
     GROUP BY i.bin_id, b.code`,
    [locationId, skuParam],
  );

  let homeless = 0;
  let inThisBin = 0;
  const inOtherBins: { binCode: string; qty: number }[] = [];
  let total = 0;
  for (const g of groups.rows) {
    const qty = Number(g.qty);
    total += qty;
    if (g.bin_id === null) {
      homeless += qty;
    } else if (targetBinId && g.bin_id === targetBinId) {
      inThisBin = qty;
    } else if (g.bin_code) {
      inOtherBins.push({ binCode: g.bin_code, qty });
    } else {
      // Items point at a non-null bin_id but the LEFT JOIN didn't return
      // a code — the bin row is archived (or rare data drift). To the
      // operator that bin doesn't exist anymore, so treat the items as
      // homeless. Pre-1.2.43 these silently fell out of every bucket and
      // a `homeless_only` assign matched nothing → "0 items assigned"
      // bug the operator just hit.
      homeless += qty;
    }
  }
  inOtherBins.sort((a, b) => b.qty - a.qty);
  return { homeless, inThisBin, inOtherBins, totalMatching: total };
}
