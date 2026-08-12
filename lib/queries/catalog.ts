import type { Pool } from "pg";

export type CatalogMatrixRow = {
  id: string;
  upc: string | null;
  description: string;
  custom_sku_count: number;
  epc_count: number;
  status_key:
    | "no_custom_skus"
    | "no_inventory"
    | "in_stock"
    | "sold_out"
    | "mixed";
};

export type CatalogCustomSkuRow = {
  id: string;
  sku: string;
  ls_system_id: string;
  color_code: string | null;
  size: string | null;
  epc_count: number;
};

export type CatalogItemRow = {
  serial_number: string;
  epc: string;
  status: string;
  bin_code: string;
  last_seen_at: string | null;
  /** Matrix description (variant-clean product name). */
  name: string;
  size: string | null;
  color: string | null;
  sku: string;
  /** Code of the bin this EPC is pinned to via the "store" pin
   *  (items.pinned_bin_id), or null when no pin is set. The RFID Tags
   *  modal renders a small colored chip next to the EPC when this is
   *  non-null. See migration 0082 + the cycle-count scan handler. */
  pinned_bin_code: string | null;
};

/** Matrix (UPC) rows with custom SKU / EPC totals for the active location. */
export async function listCatalogMatrices(
  pool: Pool,
  locationId: string,
): Promise<CatalogMatrixRow[]> {
  const r = await pool.query<{
    id: string;
    upc: string | null;
    description: string;
    custom_sku_count: string;
    epc_count: string;
    status_key: CatalogMatrixRow["status_key"];
  }>(
    `SELECT
       m.id,
       m.upc,
       m.description,
       COUNT(DISTINCT cs.id)::text AS custom_sku_count,
       -- Qty = LIVE inventory only. Terminal statuses (tag_killed, sold, …) are
       -- decommissioned tags and must NOT inflate the on-hand count. Matches
       -- active_epc_count in the grid, the stats route, and the Shopify sync.
       COUNT(i.id) FILTER (WHERE i.status = 'in-stock')::text AS epc_count,
       CASE
         WHEN COUNT(DISTINCT cs.id) = 0 THEN 'no_custom_skus'
         WHEN COUNT(i.id) = 0 THEN 'no_inventory'
         WHEN COUNT(i.id) FILTER (WHERE i.status = 'in-stock') > 0 THEN 'in_stock'
         WHEN COUNT(i.id) FILTER (WHERE i.status = 'sold') = COUNT(i.id)
              AND COUNT(i.id) > 0 THEN 'sold_out'
         ELSE 'mixed'
       END AS status_key
     FROM matrices m
     LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
     LEFT JOIN items i ON i.custom_sku_id = cs.id AND i.location_id = $1::uuid
     GROUP BY m.id, m.upc, m.description
     ORDER BY m.upc ASC`,
    [locationId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    upc: row.upc,
    description: row.description,
    custom_sku_count: Number(row.custom_sku_count),
    epc_count: Number(row.epc_count),
    status_key: row.status_key,
  }));
}

/** Custom SKU rows for one matrix at the active location. */
export async function listCatalogCustomSkus(
  pool: Pool,
  locationId: string,
  matrixId: string,
): Promise<CatalogCustomSkuRow[]> {
  const r = await pool.query<{
    id: string;
    sku: string;
    ls_system_id: string;
    color_code: string | null;
    size: string | null;
    epc_count: string;
  }>(
    `SELECT
       cs.id,
       cs.sku,
       cs.ls_system_id::text AS ls_system_id,
       cs.color_code,
       cs.size,
       -- Live inventory only (see listCatalogMatrices) — exclude killed/sold tags.
       COUNT(i.id) FILTER (WHERE i.status = 'in-stock')::text AS epc_count
     FROM custom_skus cs
     LEFT JOIN items i ON i.custom_sku_id = cs.id AND i.location_id = $2::uuid
     WHERE cs.matrix_id = $1::uuid
     GROUP BY cs.id, cs.sku, cs.ls_system_id, cs.color_code, cs.size
     ORDER BY cs.sku ASC`,
    [matrixId, locationId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    ls_system_id: row.ls_system_id,
    color_code: row.color_code,
    size: row.size,
    epc_count: Number(row.epc_count),
  }));
}

/** Physical items (EPC) for one custom SKU at the active location; bin via LEFT JOIN. */
export async function listCatalogItemsForCustomSku(
  pool: Pool,
  locationId: string,
  customSkuId: string,
): Promise<CatalogItemRow[]> {
  const r = await pool.query<{
    serial_number: string;
    epc: string;
    status: string;
    bin_code: string | null;
    last_seen_at: Date | null;
    name: string;
    size: string | null;
    color: string | null;
    sku: string;
    pinned_bin_code: string | null;
  }>(
    `SELECT
       i.serial_number::text AS serial_number,
       i.epc,
       i.status,
       COALESCE(b.code, '') AS bin_code,
       i.last_seen_at,
       m.description AS name,
       cs.size,
       cs.color_code AS color,
       cs.sku,
       pb.code AS pinned_bin_code
     FROM items i
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     INNER JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     LEFT JOIN bins pb ON pb.id = i.pinned_bin_id
     WHERE i.custom_sku_id = $1::uuid AND i.location_id = $2::uuid
     ORDER BY i.serial_number ASC`,
    [customSkuId, locationId],
  );
  return r.rows.map((row) => ({
    serial_number: row.serial_number,
    epc: row.epc,
    status: row.status,
    bin_code: row.bin_code ?? "—",
    last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    name: row.name,
    size: row.size,
    color: row.color,
    sku: row.sku,
    pinned_bin_code: row.pinned_bin_code ?? null,
  }));
}
