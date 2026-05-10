import type { Pool, PoolClient } from "pg";
import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";

/**
 * Lightspeed sync diff — what's about to change before the operator confirms.
 *
 * Compares the just-fetched Lightspeed catalog payload (matrices + variants)
 * against the current `custom_skus` rows in WMS, joined by `ls_system_id`.
 * Three groups:
 *
 *   gained  — present in Lightspeed pull, absent from WMS → will be inserted.
 *   lost    — present in WMS, absent from Lightspeed pull → will be archived
 *             (NOT deleted — preserves any items rows + history that still
 *             reference these custom_skus). Excludes the AUTO-PENDING
 *             placeholder (ls_system_id = -1) which is WMS-internal and
 *             not sourced from Lightspeed.
 *   unchanged_count — in both. The apply phase still upserts these so price
 *             / name / archive flag updates land, but the operator doesn't
 *             need to review them for "did I lose this on purpose."
 *
 * The diff is meant for the confirm-or-cancel preview modal. It's also the
 * authoritative source for the Excel download (3 sheets: Full Catalog, Items
 * Gained, Items Lost) so what's downloaded matches what'll happen on apply.
 *
 * Pure function — does not write. Caller persists the diff + cached payload
 * into sync_jobs so apply can run without re-fetching Lightspeed.
 */

export type DiffRow = {
  ls_system_id: string;
  sku: string;
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  vendor: string | null;
  retail_price: string | null;
  archived: boolean;
};

export type SyncDiff = {
  gained: DiffRow[];
  lost: DiffRow[];
  unchanged_count: number;
  /** Aggregate counts surfaced in the popup summary. */
  summary: {
    lightspeed_total_variants: number;
    lightspeed_total_matrices: number;
    lightspeed_archived_count: number;
    lightspeed_regular_count: number;
    wms_total_before: number;
    wms_total_after: number;
  };
};

const AUTO_PENDING_SYSTEM_ID = "-1";

/** Read the (sku, matrix-name, variant-fields) tuple for every current custom_sku in this tenant. */
async function loadCurrentRowsForDiff(
  pool: Pool | PoolClient,
): Promise<Map<string, DiffRow>> {
  const r = await pool.query<{
    ls_system_id: string;
    sku: string;
    name: string | null;
    color_code: string | null;
    size: string | null;
    upc: string | null;
    vendor: string | null;
    retail_price: string | null;
    archived: boolean;
  }>(
    `SELECT
       cs.ls_system_id::text AS ls_system_id,
       cs.sku,
       m.description AS name,
       cs.color_code,
       cs.size,
       COALESCE(cs.upc, m.upc) AS upc,
       m.vendor,
       cs.retail_price::text AS retail_price,
       cs.archived
     FROM custom_skus cs
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     WHERE cs.ls_system_id::text <> $1`,
    [AUTO_PENDING_SYSTEM_ID],
  );
  const map = new Map<string, DiffRow>();
  for (const row of r.rows) {
    map.set(row.ls_system_id, {
      ls_system_id: row.ls_system_id,
      sku: row.sku,
      name: row.name,
      color: row.color_code,
      size: row.size,
      upc: row.upc,
      vendor: row.vendor,
      retail_price: row.retail_price,
      archived: row.archived,
    });
  }
  return map;
}

export async function computeLightspeedSyncDiff(
  pool: Pool | PoolClient,
  payload: CatalogSyncMatrixPayload[],
): Promise<SyncDiff> {
  const current = await loadCurrentRowsForDiff(pool);

  const incoming = new Map<string, DiffRow>();
  let archivedCount = 0;
  let regularCount = 0;
  for (const matrix of payload) {
    for (const v of matrix.variants) {
      const id = String(v.lsSystemId);
      const row: DiffRow = {
        ls_system_id: id,
        sku: v.sku,
        name: matrix.description,
        color: v.color,
        size: v.size,
        upc: v.upc ?? matrix.upc ?? null,
        vendor: matrix.vendor,
        retail_price: v.retailPrice,
        archived: v.archived === true,
      };
      incoming.set(id, row);
      if (row.archived) archivedCount += 1;
      else regularCount += 1;
    }
  }

  const gained: DiffRow[] = [];
  const lost: DiffRow[] = [];
  let unchanged = 0;

  for (const [id, row] of incoming) {
    if (current.has(id)) unchanged += 1;
    else gained.push(row);
  }
  for (const [id, row] of current) {
    if (!incoming.has(id)) lost.push(row);
  }

  // Stable sort for deterministic Excel output.
  const byName = (a: DiffRow, b: DiffRow) =>
    (a.name ?? a.sku).localeCompare(b.name ?? b.sku) || a.sku.localeCompare(b.sku);
  gained.sort(byName);
  lost.sort(byName);

  return {
    gained,
    lost,
    unchanged_count: unchanged,
    summary: {
      lightspeed_total_variants: incoming.size,
      lightspeed_total_matrices: payload.length,
      lightspeed_archived_count: archivedCount,
      lightspeed_regular_count: regularCount,
      wms_total_before: current.size,
      wms_total_after: current.size + gained.length, // lost rows stay (archived), so total doesn't shrink
    },
  };
}
