import type { Pool, PoolClient } from "pg";
import { sectionRegex } from "@/lib/queries/bin-code";

export type ShelfMapLine = {
  sku_prefix: string;
  name: string;
  color: string | null;
  qty: number;
};

export type ShelfMapBin = {
  id: string;
  code: string;
  status: string;
  lines: ShelfMapLine[];
};

/**
 * Every bin in `<aisle><section>` at `locationId`, plus the lines grouped by
 * (UPC + color_code) using the project's existing SKU-prefix convention:
 *   - C-prefixed SKUs: LEFT(sku, 11)
 *   - everything else:  LEFT(sku, 9)
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
    lines: ShelfMapLine[] | null;
  }>(
    `SELECT
       b.id::text AS id,
       b.code,
       b.status,
       (
         SELECT COALESCE(
           jsonb_agg(jsonb_build_object(
             'sku_prefix', sku_prefix,
             'name', name,
             'color', color,
             'qty', qty
           ) ORDER BY name, sku_prefix),
           '[]'::jsonb
         )
         FROM (
           SELECT
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
           GROUP BY sku_prefix, name, color
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
): Promise<{ id: string; code: string; status: string; in_stock_count: number }[]> {
  const r = await pool.query<{
    id: string;
    code: string;
    status: string;
    in_stock_count: number;
  }>(
    `SELECT
       b.id::text AS id,
       b.code,
       b.status,
       COUNT(i.id) FILTER (WHERE i.status IN ('in-stock','pending_visibility'))::int AS in_stock_count
     FROM bins b
     LEFT JOIN items i
       ON i.bin_id = b.id
       AND i.location_id = $1::uuid
     WHERE b.location_id = $1::uuid
       AND b.archived_at IS NULL
       AND b.code !~ '^\\d+[A-Z][0-9]{2}[LCR]$'
     GROUP BY b.id, b.code, b.status
     ORDER BY b.code ASC`,
    [locationId],
  );
  return r.rows;
}

/**
 * Move every in-stock EPC whose SKU prefix matches `skuPrefix` from
 * `sourceBinId` (or NULL = homeless) into `targetBinId`. Operates at one
 * `locationId` only. Writes one `inventory_audit_logs` row per moved EPC
 * with reason `bin_move`. Caller must wrap in a transaction.
 *
 * Source semantics:
 *   - sourceBinId = UUID → move only from that bin
 *   - sourceBinId = null → move only from homeless (bin_id IS NULL)
 *   - sourceBinId = "any" → move from anywhere (any bin + homeless)
 */
export async function moveSkuPrefixToBin(
  client: PoolClient,
  tenantId: string,
  locationId: string,
  params: {
    skuPrefix: string;
    sourceBinId: string | null | "any";
    targetBinId: string;
  },
): Promise<{ moved: number }> {
  // Verify target bin belongs to this tenant + location and is active.
  const target = await client.query<{ code: string; status: string }>(
    `SELECT b.code, b.status
       FROM bins b
       INNER JOIN locations l ON l.id = b.location_id
      WHERE b.id = $1::uuid
        AND l.id = $2::uuid
        AND l.tenant_id = $3::uuid
        AND b.archived_at IS NULL
      LIMIT 1`,
    [params.targetBinId, locationId, tenantId],
  );
  if (!target.rows[0]) throw new Error("BAD_REQUEST:Target bin not found");
  if (target.rows[0].status === "inactive") {
    throw new Error("BAD_REQUEST:Target bin is inactive");
  }
  const targetCode = target.rows[0].code;

  // Same shape filter for source: must belong to this tenant + location.
  let sourceClause: string;
  let sourceCode: string | null = null;
  const args: unknown[] = [locationId, params.skuPrefix, params.targetBinId];

  if (params.sourceBinId === null) {
    sourceClause = "i.bin_id IS NULL";
  } else if (params.sourceBinId === "any") {
    sourceClause = "(i.bin_id IS NULL OR i.bin_id IS NOT NULL)";
  } else {
    const src = await client.query<{ code: string }>(
      `SELECT b.code
         FROM bins b
         INNER JOIN locations l ON l.id = b.location_id
        WHERE b.id = $1::uuid
          AND l.id = $2::uuid
          AND l.tenant_id = $3::uuid
          AND b.archived_at IS NULL
        LIMIT 1`,
      [params.sourceBinId, locationId, tenantId],
    );
    if (!src.rows[0]) throw new Error("BAD_REQUEST:Source bin not found");
    sourceCode = src.rows[0].code;
    sourceClause = `i.bin_id = $${args.length + 1}::uuid`;
    args.push(params.sourceBinId);
  }

  // Run the move + audit in one SQL using a CTE so we get the affected EPCs
  // back in a single round-trip.
  const moved = await client.query<{ epc: string; old_bin: string | null }>(
    `WITH affected AS (
       SELECT i.id, i.epc, i.bin_id AS old_bin_id
       FROM items i
       INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
       WHERE i.location_id = $1::uuid
         AND i.status IN ('in-stock', 'pending_visibility')
         AND (CASE WHEN cs.sku LIKE 'C%' THEN LEFT(cs.sku, 11) ELSE LEFT(cs.sku, 9) END) = $2
         AND ${sourceClause}
     ),
     updated AS (
       UPDATE items SET bin_id = $3::uuid
       WHERE id IN (SELECT id FROM affected)
       RETURNING epc
     )
     SELECT a.epc,
       (SELECT b.code FROM bins b WHERE b.id = a.old_bin_id) AS old_bin
     FROM affected a`,
    args,
  );

  for (const row of moved.rows) {
    const oldVal = row.old_bin ?? "(homeless)";
    await client.query(
      `INSERT INTO inventory_audit_logs (
         tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id
       )
       VALUES (
         $1::uuid, 'ADJUSTMENT', 'EPC', $2, $3, $4, 'bin_move', NULL
       )`,
      [tenantId, row.epc, oldVal, targetCode],
    );
  }

  // Variant-level home-bin assignment: mark EVERY size of this colour as
  // assigned to the target bin — INCLUDING zero-qty sizes with no EPCs — so the
  // catalog shows the whole colour as assigned. This is display metadata only;
  // it never creates inventory and bin SCANNING still reads live items only.
  await client.query(
    `UPDATE custom_skus cs
        SET assigned_bin_id = $2::uuid
      WHERE (CASE WHEN cs.sku LIKE 'C%' THEN LEFT(cs.sku, 11) ELSE LEFT(cs.sku, 9) END) = $1`,
    [params.skuPrefix, params.targetBinId],
  );

  void sourceCode; // captured above for potential future use
  return { moved: moved.rows.length };
}

/* Per-line ✕ Remove uses the existing `POST /api/locations/bins/:id/clean`
 * with `{ skuPrefix }` — already implemented in `lib/queries/clean-bin.ts`.
 * No second remove path here.
 */
