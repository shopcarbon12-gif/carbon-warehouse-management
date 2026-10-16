import type { Pool } from "pg";
import {
  assignToBin,
  publicChanges,
  type BinActor,
  type BinChange,
  type SkuGroup,
} from "@/lib/server/bin-engine";

export type PutawayScope = "all_colors" | "single_color_all_sizes";

/**
 * Move RFID items to a bin by scanned custom SKU.
 *
 * The mobile app strips the size before sending, so `skuScanned` is expected
 * to be matrix+color (e.g. `1125444B8` non-legacy / `C11111001C7` legacy) for
 * `single_color_all_sizes`, and the full custom SKU for `all_colors` is fine
 * because we resolve the matrix from any child SKU.
 *
 * `matrixId` pins the scan to ONE product. Since migration 0092 two matrices
 * may share a UPC, so `sku LIKE '<prefix>%'` can match a second product's
 * variants and quietly bin them too — and for `all_colors` the matrix lookup
 * by SKU text picked an arbitrary one of the two. The handheld knows the
 * matrix it resolved the scan to, so it sends it. Null = legacy behaviour.
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
 *
 * Runs on the shared bin engine (lib/server/bin-engine.ts): same rule as the
 * desktop Shelf Map / catalog Move & Add, writes bin_move / bin_add history
 * with the user and handheld, keeps the colour's home bin, refuses inactive
 * bins, and returns before → after per EPC for an exact Undo.
 */
export async function assignItemsToBinBySkuScan(
  pool: Pool,
  tenantId: string,
  locationId: string,
  binCode: string,
  skuScanned: string,
  scope: PutawayScope,
  mode: "homeless_only" | "all" = "homeless_only",
  matrixId: string | null | undefined,
  actor: BinActor,
): Promise<{ updated: number; changes: BinChange[]; binId: string | null }> {
  const trimmed = skuScanned.trim();
  if (!trimmed) return { updated: 0, changes: [], binId: null };

  const bin = await pool.query<{ id: string }>(
    // Normalize both stored code and input parameter — strip every
    // non-alphanumeric char and uppercase. Mobile clients format 5-char
    // codes with dashes for display (e.g. `_formatBinCode` turns
    // "1A01L" into "1-A-01-L") and ship the dashed form to API endpoints.
    `SELECT id::text FROM bins
       WHERE location_id = $1::uuid
         AND archived_at IS NULL
         AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g')
             = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
       ORDER BY code
       LIMIT 1`,
    [locationId, binCode.trim()],
  );
  const binId = bin.rows[0]?.id;
  if (!binId) return { updated: 0, changes: [], binId: null };

  // single_color_all_sizes: LIKE prefix (the app strips the size);
  // all_colors: every SKU of the matrix.
  const matrix = (matrixId ?? "").trim() || null;
  let group: SkuGroup;
  if (scope === "single_color_all_sizes") {
    group = {
      sql: (n) => `SELECT id FROM custom_skus WHERE sku LIKE $${n} AND ($${n + 1}::uuid IS NULL OR matrix_id = $${n + 1}::uuid)`,
      params: [`${trimmed}%`, matrix],
    };
  } else {
    let resolved = matrix;
    if (!resolved) {
      // Legacy client: no matrix on the wire. LIMIT 1 over a SKU that two
      // products may share picks an arbitrary one — the caller should send
      // matrixId instead.
      const skuRow = await pool.query<{ matrix_id: string }>(
        `SELECT matrix_id::text FROM custom_skus WHERE sku = $1 ORDER BY archived ASC, id LIMIT 1`,
        [trimmed],
      );
      resolved = skuRow.rows[0]?.matrix_id ?? null;
    }
    if (!resolved) return { updated: 0, changes: [], binId };
    group = { sql: (n) => `SELECT id FROM custom_skus WHERE matrix_id = $${n}::uuid`, params: [resolved] };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { changes } = await assignToBin(
      client,
      tenantId,
      locationId,
      binId,
      mode === "all" ? "move" : "add",
      group,
      actor,
    );
    await client.query("COMMIT");
    return { updated: changes.length, changes: publicChanges(changes), binId };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  } finally {
    client.release();
  }
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
  matrixId?: string | null,
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
         AND archived_at IS NULL
         AND regexp_replace(upper(code), '[^A-Z0-9]', '', 'g')
             = regexp_replace(upper($2), '[^A-Z0-9]', '', 'g')
       LIMIT 1`,
    [locationId, binCode.trim()],
  );
  const targetBinId = bin.rows[0]?.id ?? null;

  // Mirrors the filter in assignItemsToBinBySkuScan — the preview has to
  // count exactly the rows the assign will touch, or the ADD/MOVE prompt
  // and the "0 items" messages describe a different set than the operator
  // is about to change.
  const matrix = (matrixId ?? "").trim() || null;
  let skuFilter: string;
  const params: unknown[] = [locationId];
  if (scope === "single_color_all_sizes") {
    skuFilter = `custom_sku_id IN (
      SELECT id FROM custom_skus
       WHERE sku LIKE $2 AND ($3::uuid IS NULL OR matrix_id = $3::uuid))`;
    params.push(`${trimmed}%`, matrix);
  } else {
    let resolved = matrix;
    if (!resolved) {
      const skuRow = await pool.query<{ matrix_id: string }>(
        `SELECT matrix_id::text FROM custom_skus WHERE sku = $1 ORDER BY archived ASC, id LIMIT 1`,
        [trimmed],
      );
      resolved = skuRow.rows[0]?.matrix_id ?? null;
    }
    if (!resolved) return empty;
    skuFilter = `custom_sku_id IN (SELECT id FROM custom_skus WHERE matrix_id = $2::uuid)`;
    params.push(resolved);
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
    params,
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
