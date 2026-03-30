import type { Pool } from "pg";

export type CatalogGridRow = {
  custom_sku_id: string;
  matrix_id: string;
  /** Matrix-level Lightspeed-style numeric id when present. */
  matrix_ls_system_id: string | null;
  sku: string;
  /** Variant UPC when set; matrix UPC always available as `matrix_upc`. */
  sku_upc: string | null;
  matrix_upc: string;
  name: string;
  vendor: string | null;
  color: string | null;
  size: string | null;
  retail_price: string | null;
  /** Last total on-hand from Lightspeed catalog sync (not RFID). */
  ls_on_hand_total: number | null;
  active_epc_count: number;
};

export type CatalogGridResult = {
  rows: CatalogGridRow[];
  total: number;
  brands: string[];
  categories: string[];
  vendors: string[];
};

function buildWhere(
  q: string,
  brand: string,
  category: string,
  vendor: string,
): { sql: string; params: unknown[] } {
  const parts: string[] = ["1=1"];
  const params: unknown[] = [];
  let i = 1;

  const qt = q.trim();
  if (qt) {
    parts.push(
      `(
        COALESCE(m.ls_system_id::text, '') ILIKE $${i}
        OR m.description ILIKE $${i}
        OR cs.sku ILIKE $${i}
        OR m.upc ILIKE $${i}
        OR COALESCE(cs.upc, '') ILIKE $${i}
        OR COALESCE(m.vendor, '') ILIKE $${i}
      )`,
    );
    params.push(`%${qt}%`);
    i += 1;
  }

  if (brand.trim()) {
    parts.push(`m.brand = $${i}`);
    params.push(brand.trim());
    i += 1;
  }
  if (category.trim()) {
    parts.push(`m.category = $${i}`);
    params.push(category.trim());
    i += 1;
  }
  if (vendor.trim()) {
    parts.push(`m.vendor = $${i}`);
    params.push(vendor.trim());
    i += 1;
  }

  return { sql: parts.join(" AND "), params };
}

export async function listCatalogFilterOptions(pool: Pool): Promise<{
  brands: string[];
  categories: string[];
  vendors: string[];
}> {
  const [br, cat, ven] = await Promise.all([
    pool.query<{ v: string }>(
      `SELECT DISTINCT brand AS v FROM matrices WHERE brand IS NOT NULL AND trim(brand) <> '' ORDER BY 1`,
    ),
    pool.query<{ v: string }>(
      `SELECT DISTINCT category AS v FROM matrices WHERE category IS NOT NULL AND trim(category) <> '' ORDER BY 1`,
    ),
    pool.query<{ v: string }>(
      `SELECT DISTINCT vendor AS v FROM matrices WHERE vendor IS NOT NULL AND trim(vendor) <> '' ORDER BY 1`,
    ),
  ]);
  return {
    brands: br.rows.map((r) => r.v),
    categories: cat.rows.map((r) => r.v),
    vendors: ven.rows.map((r) => r.v),
  };
}

export async function listCatalogGrid(
  pool: Pool,
  options: {
    page: number;
    limit: number;
    q: string;
    brand: string;
    category: string;
    vendor: string;
    locationId: string;
  },
): Promise<CatalogGridResult> {
  const { page, limit, q, brand, category, vendor, locationId } = options;
  const safeLimit = Math.min(100, Math.max(1, limit));
  const offset = Math.max(0, (page - 1) * safeLimit);

  const { sql: whereSql, params: whereParams } = buildWhere(q, brand, category, vendor);

  const countR = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     WHERE ${whereSql}`,
    whereParams,
  );
  const total = Number(countR.rows[0]?.c ?? 0);

  const locIdx = whereParams.length + 1;
  const limIdx = whereParams.length + 2;
  const offIdx = whereParams.length + 3;
  const dataParams = [...whereParams, locationId, safeLimit, offset];

  const data = await pool.query<{
    custom_sku_id: string;
    matrix_id: string;
    matrix_ls_system_id: string | null;
    sku: string;
    sku_upc: string | null;
    matrix_upc: string;
    name: string;
    vendor: string | null;
    color: string | null;
    size: string | null;
    retail_price: string | null;
    ls_on_hand_total: string | null;
    active_epc_count: string;
  }>(
    `SELECT
       cs.id::text AS custom_sku_id,
       m.id::text AS matrix_id,
       m.ls_system_id::text AS matrix_ls_system_id,
       cs.sku,
       cs.upc AS sku_upc,
       m.upc AS matrix_upc,
       m.description AS name,
       m.vendor,
       cs.color_code AS color,
       cs.size,
       cs.retail_price::text AS retail_price,
       cs.ls_on_hand_total::text AS ls_on_hand_total,
       (
         SELECT COUNT(*)::text
         FROM items i
         WHERE i.custom_sku_id = cs.id
           AND i.location_id = $${locIdx}::uuid
           AND i.status = 'in-stock'
       ) AS active_epc_count
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     WHERE ${whereSql}
     ORDER BY m.upc ASC, cs.sku ASC
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    dataParams,
  );

  const filters = await listCatalogFilterOptions(pool);

  return {
    rows: data.rows.map((row) => ({
      custom_sku_id: row.custom_sku_id,
      matrix_id: row.matrix_id,
      matrix_ls_system_id: row.matrix_ls_system_id,
      sku: row.sku,
      sku_upc: row.sku_upc,
      matrix_upc: row.matrix_upc,
      name: row.name,
      vendor: row.vendor,
      color: row.color,
      size: row.size,
      retail_price: row.retail_price,
      ls_on_hand_total: (() => {
        if (row.ls_on_hand_total == null || row.ls_on_hand_total === "") return null;
        const n = Number(row.ls_on_hand_total);
        return Number.isFinite(n) ? n : null;
      })(),
      active_epc_count: Number(row.active_epc_count ?? 0),
    })),
    total,
    brands: filters.brands,
    categories: filters.categories,
    vendors: filters.vendors,
  };
}
