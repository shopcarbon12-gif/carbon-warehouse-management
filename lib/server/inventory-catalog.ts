import type { Pool } from "pg";

export type CatalogGridRow = {
  custom_sku_id: string;
  matrix_id: string;
  /** Matrix-level Lightspeed-style numeric id when present. */
  matrix_ls_system_id: string | null;
  /** Variant-level Lightspeed System ID — this is what is encoded in EPC bits 20-60. */
  sku_ls_system_id: string | null;
  sku: string;
  /** Variant UPC when set; matrix UPC available as `matrix_upc` (also nullable). */
  sku_upc: string | null;
  matrix_upc: string | null;
  name: string;
  vendor: string | null;
  color: string | null;
  size: string | null;
  retail_price: string | null;
  /** Last total on-hand from Lightspeed catalog sync (not RFID). */
  ls_on_hand_total: number | null;
  active_epc_count: number;
  bin_location: string | null;
  /** Variant archive flag synced from Lightspeed. */
  archived: boolean;
  /** True only when every variant under the same matrix is archived. */
  matrix_archived: boolean;
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
  systemId: string,
  locationId: string,
  showArchived: boolean,
): { sql: string; params: unknown[] } {
  const parts: string[] = ["1=1"];
  const params: unknown[] = [];
  let i = 1;

  if (!showArchived) {
    parts.push(`cs.archived = FALSE`);
  }

  // Exact variant-level system ID match — used by handheld EPC lookup
  const sid = systemId.trim();
  if (sid) {
    parts.push(`cs.ls_system_id::text = $${i}`);
    params.push(sid);
    i += 1;
  }

  const qt = q.trim();
  if (qt) {
    const hasLoc = locationId.trim().length > 0;
    params.push(`%${qt}%`);
    const binExistsClause = hasLoc
      ? `OR EXISTS (
          SELECT 1 FROM items ix
          INNER JOIN bins bx ON bx.id = ix.bin_id
          WHERE ix.custom_sku_id = cs.id
            AND ix.location_id = $${i + 1}::uuid
            AND ix.status = 'in-stock'
            AND ix.bin_id IS NOT NULL
            AND bx.archived_at IS NULL
            AND bx.code ILIKE $${i}
        )`
      : "";
    if (hasLoc) {
      params.push(locationId.trim());
    }
    parts.push(
      `(
        COALESCE(m.ls_system_id::text, '') ILIKE $${i}
        OR COALESCE(cs.ls_system_id::text, '') ILIKE $${i}
        OR m.description ILIKE $${i}
        OR cs.sku ILIKE $${i}
        OR m.upc ILIKE $${i}
        OR COALESCE(cs.upc, '') ILIKE $${i}
        OR COALESCE(m.vendor, '') ILIKE $${i}
        ${binExistsClause}
      )`,
    );
    i += hasLoc ? 2 : 1;
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

const SORT_COLUMNS: Record<string, string> = {
  system_id: "cs.ls_system_id",
  name: "m.description",
  sku: "cs.sku",
  upc: "m.upc",
  vendor: "m.vendor",
  color: "cs.color_code",
  size: "cs.size",
  retail_price: "cs.retail_price",
  bin: "bin_location",
  qty_epc: "active_epc_count",
};

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
    systemId?: string;
    sortBy?: string;
    sortDir?: string;
    showArchived?: boolean;
  },
): Promise<CatalogGridResult> {
  const {
    page, limit, q, brand, category, vendor, locationId,
    systemId = "", sortBy = "", sortDir = "", showArchived = false,
  } = options;
  const safeLimit = Math.min(100, Math.max(1, limit));
  const offset = Math.max(0, (page - 1) * safeLimit);

  const { sql: whereSql, params: whereParams } = buildWhere(
    q, brand, category, vendor, systemId, locationId, showArchived,
  );

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
    sku_ls_system_id: string | null;
    sku: string;
    sku_upc: string | null;
    matrix_upc: string | null;
    name: string;
    vendor: string | null;
    color: string | null;
    size: string | null;
    retail_price: string | null;
    ls_on_hand_total: string | null;
    active_epc_count: number;
    bin_location: string | null;
    archived: boolean;
    matrix_archived: boolean;
  }>(
    `SELECT
       cs.id::text AS custom_sku_id,
       m.id::text AS matrix_id,
       m.ls_system_id::text AS matrix_ls_system_id,
       cs.ls_system_id::text AS sku_ls_system_id,
       cs.sku,
       cs.upc AS sku_upc,
       m.upc AS matrix_upc,
       m.description AS name,
       m.vendor,
       cs.color_code AS color,
       cs.size,
       cs.retail_price::text AS retail_price,
       cs.ls_on_hand_total::text AS ls_on_hand_total,
       cs.archived AS archived,
       bool_and(cs.archived) OVER (PARTITION BY cs.matrix_id) AS matrix_archived,
       (
         (
           SELECT COUNT(*)::int
           FROM items i
           WHERE i.custom_sku_id = cs.id
             AND i.location_id = $${locIdx}::uuid
             AND i.status = 'in-stock'
         )
         +
         COALESCE((
           SELECT SUM(qty_delta)::int
           FROM inventory_adjustments ia
           WHERE ia.custom_sku_id = cs.id
             AND ia.location_id = $${locIdx}::uuid
             AND ia.state = 'settled'
         ), 0)
       ) AS active_epc_count,
       (
         SELECT string_agg(DISTINCT b.code, ', ' ORDER BY b.code)
         FROM items i
         INNER JOIN bins b ON b.id = i.bin_id
         WHERE i.custom_sku_id = cs.id
           AND i.location_id = $${locIdx}::uuid
           AND i.status = 'in-stock'
           AND i.bin_id IS NOT NULL
           AND b.archived_at IS NULL
       ) AS bin_location
     FROM custom_skus cs
     INNER JOIN matrices m ON m.id = cs.matrix_id
     WHERE ${whereSql}
     ORDER BY ${(() => {
       const col = SORT_COLUMNS[sortBy] ?? null;
       const dir = sortDir === "desc" ? "DESC NULLS LAST" : "ASC NULLS LAST";
       if (col === "bin_location" || col === "active_epc_count") return `${col} ${dir}, cs.sku ASC`;
       if (col) return `${col} ${dir}, cs.sku ASC`;
       return "m.upc ASC, cs.sku ASC";
     })()}
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    dataParams,
  );

  const filters = await listCatalogFilterOptions(pool);

  return {
    rows: data.rows.map((row) => ({
      custom_sku_id: row.custom_sku_id,
      matrix_id: row.matrix_id,
      matrix_ls_system_id: row.matrix_ls_system_id,
      sku_ls_system_id: row.sku_ls_system_id,
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
      bin_location: row.bin_location ?? null,
      archived: row.archived === true,
      matrix_archived: row.matrix_archived === true,
    })),
    total,
    brands: filters.brands,
    categories: filters.categories,
    vendors: filters.vendors,
  };
}
