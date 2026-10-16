import type { Pool, PoolClient } from "pg";
import { sectionRegex } from "@/lib/queries/bin-code";
import {
  assignToBin,
  publicChanges,
  type BinActor,
  type BinChange,
  type SkuGroup,
} from "@/lib/server/bin-engine";

export type ShelfMapLine = {
  /** Identifies the PRODUCT. Two matrices can share a UPC (migration 0092),
   *  which makes `sku_prefix` ambiguous — every bin operation carries this. */
  matrix_id: string;
  sku_prefix: string;
  name: string;
  color: string | null;
  qty: number;
};

export type ShelfMapBin = {
  id: string;
  code: string;
  status: string;
  capacity: number | null;
  lines: ShelfMapLine[];
};

/**
 * Every bin in `<aisle><section>` at `locationId`, plus the lines grouped by
 * (product + UPC + color_code) using the project's existing SKU-prefix
 * convention:
 *   - C-prefixed SKUs: LEFT(sku, 11)
 *   - everything else:  LEFT(sku, 9)
 *
 * The group key leads with `matrix_id`: since migration 0092 two products may
 * share a UPC, so the same `sku_prefix` can legitimately appear twice in one
 * bin (e.g. `122380304` GREY = "Cole Pants" AND "Kyle Cargo"). Move/Remove
 * carry the matrix id so they only ever touch the line the operator clicked.
 *
 * Lines are pulled from both `bin_id = b.id` (primary) and
 * `b.id = ANY(additional_bin_ids)` (multi-bin secondaries) — same rule as
 * `listBinContentsGrouped` so the shelf map agrees with the existing list view.
 *
 * Qty = COUNT of in-stock + pending_visibility items, summed across all sizes
 * that share the same sku_prefix. The matrix description has its trailing
 * size token stripped — same regex the existing Items column uses.
 */
export async function listShelfMapSection(
  pool: Pool,
  locationId: string,
  aisle: string,
  section: string,
): Promise<ShelfMapBin[]> {
  const re = sectionRegex(aisle, section);
  const r = await pool.query<{
    id: string;
    code: string;
    status: string;
    capacity: number | null;
    lines: ShelfMapLine[] | null;
  }>(
    `SELECT
       b.id::text AS id,
       b.code,
       b.status,
       b.capacity,
       (
         SELECT COALESCE(
           jsonb_agg(jsonb_build_object(
             'matrix_id', matrix_id,
             'sku_prefix', sku_prefix,
             'name', name,
             'color', color,
             'qty', qty
           ) ORDER BY name, sku_prefix),
           '[]'::jsonb
         )
         FROM (
           SELECT
             m.id::text AS matrix_id,
             CASE WHEN cs.sku LIKE 'C%' THEN LEFT(cs.sku, 11) ELSE LEFT(cs.sku, 9) END AS sku_prefix,
             REGEXP_REPLACE(m.description, '\\s+\\S+$', '') AS name,
             cs.color_code AS color,
             COUNT(i.id)::int AS qty
           FROM items i
           INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
           INNER JOIN matrices m ON m.id = cs.matrix_id
           WHERE i.location_id = $1::uuid
             AND i.status IN ('in-stock', 'pending_visibility')
             AND (i.bin_id = b.id OR b.id = ANY(i.additional_bin_ids))
           GROUP BY m.id, sku_prefix, name, color
         ) sub
       ) AS lines
     FROM bins b
     WHERE b.location_id = $1::uuid
       AND b.archived_at IS NULL
       AND b.code ~ $2
     ORDER BY b.code ASC`,
    [locationId, re],
  );
  return r.rows.map((row) => ({
    id: row.id,
    code: row.code,
    status: row.status,
    capacity: row.capacity ?? null,
    lines: Array.isArray(row.lines) ? row.lines : [],
  }));
}

/**
 * Returns the discovery payload for the toolbar: every (aisle, section)
 * combination that has at least one parseable bin at this location.
 * The UI uses this to populate the dropdowns without an extra round-trip.
 */
export async function listShelfMapNavigation(
  pool: Pool,
  locationId: string,
): Promise<{ aisle: string; section: string; bin_count: number }[]> {
  const r = await pool.query<{
    aisle: string;
    section: string;
    bin_count: number;
  }>(
    `SELECT
       SUBSTRING(b.code FROM '^(\\d+)[A-Z][0-9]{2}[LCR]$') AS aisle,
       SUBSTRING(b.code FROM '^\\d+([A-Z])[0-9]{2}[LCR]$') AS section,
       COUNT(*)::int AS bin_count
     FROM bins b
     WHERE b.location_id = $1::uuid
       AND b.archived_at IS NULL
       AND b.code ~ '^\\d+[A-Z][0-9]{2}[LCR]$'
     GROUP BY aisle, section
     ORDER BY aisle, section`,
    [locationId],
  );
  return r.rows.filter((row) => row.aisle && row.section);
}

/**
 * Bins at this location whose code does NOT match the standard pattern
 * (e.g. RECEIVING-01, FLOOR-A, RTV-HOLD). Returned with their in-stock counts
 * so the Shelf Map tab can render them in a small panel below the grid.
 */
export async function listUnmappedBins(
  pool: Pool,
  locationId: string,
): Promise<{ id: string; code: string; status: string; capacity: number | null; in_stock_count: number }[]> {
  const r = await pool.query<{
    id: string;
    code: string;
    status: string;
    capacity: number | null;
    in_stock_count: number;
  }>(
    `SELECT
       b.id::text AS id,
       b.code,
       b.status,
       b.capacity,
       -- primary OR extra bin, like every other bin view
       (SELECT COUNT(*) FROM items i
         WHERE i.location_id = $1::uuid
           AND i.status IN ('in-stock','pending_visibility')
           AND (i.bin_id = b.id OR b.id = ANY(i.additional_bin_ids)))::int AS in_stock_count
     FROM bins b
     WHERE b.location_id = $1::uuid
       AND b.archived_at IS NULL
       AND b.code !~ '^\\d+[A-Z][0-9]{2}[LCR]$'
     ORDER BY b.code ASC`,
    [locationId],
  );
  return r.rows;
}

/**
 * Put one product's (UPC + colour) group into `targetBinId` — Shelf Map
 * Move / Add / Add item and the catalog's Move-to-bin. Runs on the shared bin
 * engine (lib/server/bin-engine.ts), the same rule as the handheld Bin Assign.
 * Must be wrapped in a transaction by the caller.
 *
 * `matrixId` narrows the group to ONE product (two products can share a UPC
 * and therefore a SKU prefix — Cole Pants GREY / Kyle Cargo GREY).
 *
 * `mode`:
 *   - `"move"` (default) — every tag of the group ends up in this bin only,
 *     wherever it was. `sourceBinId` no longer narrows a move: Shelf Map sent
 *     the cell's bin and the server moved only tags whose PRIMARY bin it was,
 *     so a product listed there as an extra bin moved 0 tags while the dialog
 *     closed as if it worked. `sourceBinId: null` still means "only tags with
 *     no bin".
 *   - `"add"` — tags without a live bin get this one as primary; tags in
 *     another bin keep it and list this one as an extra bin.
 */
export async function assignSkuGroupToBin(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  params: {
    skuPrefix: string;
    matrixId?: string | null;
    sourceBinId: string | null | "any";
    targetBinId: string;
    mode?: "move" | "add";
  },
  actor: BinActor,
): Promise<{ moved: number; changes: BinChange[] }> {
  const mode = params.mode ?? "move";
  const group: SkuGroup = {
    sql: (n) => `SELECT cs.id FROM custom_skus cs
       WHERE (CASE WHEN cs.sku LIKE 'C%' THEN LEFT(cs.sku, 11) ELSE LEFT(cs.sku, 9) END) = $${n}
         AND ($${n + 1}::uuid IS NULL OR cs.matrix_id = $${n + 1}::uuid)`,
    params: [params.skuPrefix, params.matrixId ?? null],
  };
  const { changes } = await assignToBin(
    client,
    tenantId,
    locationId,
    params.targetBinId,
    mode === "add" ? "add" : params.sourceBinId === null ? "homeless" : "move",
    group,
    actor,
  );
  return { moved: changes.length, changes: publicChanges(changes) };
}

/* Per-line ✕ Remove uses the existing `POST /api/locations/bins/:id/clean`
 * with `{ skuPrefix }` — already implemented in `lib/queries/clean-bin.ts`.
 * No second remove path here.
 */
