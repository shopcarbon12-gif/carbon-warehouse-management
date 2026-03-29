import type { Pool } from "pg";

export type CatalogMatrixRow = {
  id: string;
  upc: string;
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
};

/** Matrix (UPC) rows with custom SKU / EPC totals for the active location. */
export async function listCatalogMatrices(
  pool: Pool,
  locationId: string,
): Promise<CatalogMatrixRow[]> {
  const r = await pool.query<{
    id: string;
    upc: string;
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
       COUNT(i.id)::text AS epc_count,
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
       COUNT(i.id)::text AS epc_count
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
  }>(
    `SELECT
       i.serial_number::text AS serial_number,
       i.epc,
       i.status,
       COALESCE(b.code, '') AS bin_code
     FROM items i
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.custom_sku_id = $1::uuid AND i.location_id = $2::uuid
     ORDER BY i.serial_number ASC`,
    [customSkuId, locationId],
  );
  return r.rows.map((row) => ({
    serial_number: row.serial_number,
    epc: row.epc,
    status: row.status,
    bin_code: row.bin_code ?? "—",
  }));
}
