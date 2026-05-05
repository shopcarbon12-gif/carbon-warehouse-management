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
 *   - `"homeless_only"` — operator picked **ADD**. Items that have no
 *     live bin home (bin_id NULL / archived / orphan) get bin_id set to
 *     this bin. Items currently in OTHER live bins keep their primary
 *     bin (truth bin for qty) and gain this bin in `additional_bin_ids`
 *     so bin contents views list the SKU under both bins. Items already
 *     primary-or-additional in this bin are no-ops. 1.2.47 multi-bin
 *     semantics — operator's rule: "if item in multi bin, use only 1
 *     random bin for truth qty of items".
 *   - `"all"` — operator picked **MOVE**. Pull every matching item out
 *     of wherever it lives (incl. additional_bin_ids on other rows) and
 *     repoint bin_id to this bin, also clearing additional_bin_ids so a
 *     subsequent "in this bin" preview returns the right count.
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
    // Normalize both stored code and input parameter — strip every
    // non-alphanumeric char and uppercase. Mobile clients format 5-char
    // codes with dashes for display (e.g. `_formatBinCode` turns
    // "1A01L" into "1-A-01-L") and ship the dashed form to API endpoints.
    // The bins table stores the undashed canonical form ("1A01L") from
    // the orlando-bin-grid seed. Pre-1.2.46 the equality test failed
    // silently, server returned `updated: 0`, and the mobile rendered
    // "0 items assigned, every matching EPC is already placed" with no
    // hint that the lookup itself missed. regexp_replace runs over a
    // few-hundred-row bin table per request — cheap enough vs the
    // cumulative operator-frustration cost.
    `SELECT id::text FROM bins
       WHERE location_id = $1::uuid
         AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g')
             = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
       LIMIT 1`,
    [locationId, binCode.trim()],
  );
  const binId = bin.rows[0]?.id;
  if (!binId) return { updated: 0 };

  // Build the SKU filter once — single_color_all_sizes uses LIKE prefix
  // match, all_colors resolves to a matrix UUID via custom_skus.
  let skuFilter: string;
  let skuParam: string | null;
  if (scope === "single_color_all_sizes") {
    skuFilter = `custom_sku_id IN (SELECT id FROM custom_skus WHERE sku LIKE $3)`;
    skuParam = `${trimmed}%`;
  } else {
    const skuRow = await pool.query<{ matrix_id: string }>(
      `SELECT matrix_id::text FROM custom_skus WHERE sku = $1 LIMIT 1`,
      [trimmed],
    );
    const matrixId = skuRow.rows[0]?.matrix_id;
    if (!matrixId) return { updated: 0 };
    skuFilter = `custom_sku_id IN (SELECT id FROM custom_skus WHERE matrix_id = $3::uuid)`;
    skuParam = matrixId;
  }

  if (mode === "all") {
    // MOVE — pull every matching item out of wherever it lives (primary
    // OR multi-bin secondary) and into this bin. Reset additional_bin_ids
    // so the next preview sees them only here.
    const r = await pool.query(
      `UPDATE items
         SET bin_id = $1::uuid,
             additional_bin_ids = '{}'::uuid[]
       WHERE location_id = $2::uuid
         AND status IN ('in-stock', 'pending_visibility')
         AND ${skuFilter}`,
      [binId, locationId, skuParam],
    );
    return { updated: r.rowCount ?? 0 };
  }

  // ADD — multi-bin path. Three buckets, each gets a separate UPDATE:
  //
  //   1. Homeless items (bin_id NULL or pointing to archived/orphan bin)
  //      → set bin_id = target. Don't touch additional_bin_ids.
  //   2. Items currently in OTHER live bins → keep their bin_id (truth
  //      bin for qty), append target to additional_bin_ids if not
  //      already there. The bin contents view unions both, so the SKU
  //      will appear under both bins from the operator's perspective.
  //   3. Items already in target (primary or additional) → no-op,
  //      excluded by both UPDATEs' WHERE clauses.
  //
  // Returning the affected EPCs from each step lets us tally one final
  // `updated` count without double-counting.
  const homelessRes = await pool.query<{ id: string }>(
    `UPDATE items
       SET bin_id = $1::uuid
     WHERE location_id = $2::uuid
       AND status IN ('in-stock', 'pending_visibility')
       AND ${skuFilter}
       AND (
         bin_id IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM bins b
           WHERE b.id = items.bin_id
             AND b.archived_at IS NULL
         )
       )
     RETURNING id::text`,
    [binId, locationId, skuParam],
  );

  const multiBinRes = await pool.query<{ id: string }>(
    `UPDATE items
       SET additional_bin_ids = additional_bin_ids || ARRAY[$1::uuid]
     WHERE location_id = $2::uuid
       AND status IN ('in-stock', 'pending_visibility')
       AND ${skuFilter}
       AND bin_id IS NOT NULL
       AND bin_id <> $1::uuid
       AND NOT ($1::uuid = ANY(additional_bin_ids))
       AND EXISTS (
         SELECT 1 FROM bins b
         WHERE b.id = items.bin_id
           AND b.archived_at IS NULL
       )
     RETURNING id::text`,
    [binId, locationId, skuParam],
  );

  return {
    updated: (homelessRes.rowCount ?? 0) + (multiBinRes.rowCount ?? 0),
  };
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
    // Normalize both stored code and input parameter — strip every
    // non-alphanumeric char and uppercase. Mobile clients format 5-char
    // codes with dashes for display (e.g. `_formatBinCode` turns
    // "1A01L" into "1-A-01-L") and ship the dashed form to API endpoints.
    // The bins table stores the undashed canonical form ("1A01L") from
    // the orlando-bin-grid seed. Pre-1.2.46 the equality test failed
    // silently, server returned `updated: 0`, and the mobile rendered
    // "0 items assigned, every matching EPC is already placed" with no
    // hint that the lookup itself missed. regexp_replace runs over a
    // few-hundred-row bin table per request — cheap enough vs the
    // cumulative operator-frustration cost.
    `SELECT id::text FROM bins
       WHERE location_id = $1::uuid
         AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g')
             = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
       LIMIT 1`,
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

  // Per-item rows so we can classify by primary bin vs additional bins.
  // Pre-1.2.47 we GROUPed by bin_id alone; that was fine when each EPC
  // lived in exactly one bin. With multi-bin (additional_bin_ids), an
  // item can be both "in the target bin" (via additional_bin_ids) AND
  // "in some other bin" (via primary bin_id) — we want to count it as
  // inThisBin, since for the operator scanning this bin it IS here.
  const rows = await pool.query<{
    bin_id: string | null;
    bin_code: string | null;
    additional: string[] | null;
  }>(
    `SELECT i.bin_id::text AS bin_id,
            b.code AS bin_code,
            ARRAY(SELECT x::text FROM unnest(i.additional_bin_ids) x)::text[] AS additional
     FROM items i
     LEFT JOIN bins b ON b.id = i.bin_id AND b.archived_at IS NULL
     WHERE i.location_id = $1::uuid
       AND i.status IN ('in-stock', 'pending_visibility')
       AND i.${skuFilter}`,
    [locationId, skuParam],
  );

  let homeless = 0;
  let inThisBin = 0;
  const otherCounts = new Map<string, number>();
  let total = 0;
  for (const r of rows.rows) {
    total += 1;
    const additional = r.additional ?? [];
    const inTarget =
      (targetBinId && r.bin_id === targetBinId) ||
      (targetBinId && additional.includes(targetBinId));
    if (inTarget) {
      inThisBin += 1;
      continue;
    }
    if (r.bin_id === null) {
      homeless += 1;
      continue;
    }
    if (r.bin_code) {
      otherCounts.set(r.bin_code, (otherCounts.get(r.bin_code) ?? 0) + 1);
      continue;
    }
    // Items point at a non-null bin_id but the LEFT JOIN didn't return
    // a code — bin row is archived (or rare data drift). Treat as
    // homeless: to the operator the bin doesn't exist in the warehouse.
    homeless += 1;
  }
  const inOtherBins = Array.from(otherCounts.entries())
    .map(([binCode, qty]) => ({ binCode, qty }))
    .sort((a, b) => b.qty - a.qty);
  return { homeless, inThisBin, inOtherBins, totalMatching: total };
}
