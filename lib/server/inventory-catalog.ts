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
  /** Matrix-level merchandise brand (e.g. "CARBON"). */
  brand: string | null;
  color: string | null;
  size: string | null;
  /** Variant-level landed/wholesale unit cost (NUMERIC(12,4) on custom_skus). */
  default_cost: string | null;
  retail_price: string | null;
  /** Matrix-level merchandise category (e.g. "WOMEN"). */
  category: string | null;
  /** Matrix-level second-tier merchandise tag (e.g. "DRESS"). */
  subcategory_1: string | null;
  /** Last total on-hand from Lightspeed catalog sync (not RFID). */
  ls_on_hand_total: number | null;
  active_epc_count: number;
  bin_location: string | null;
  /** True when this variant is linked to a Shopify variant (has shopify_variant_id). */
  shopify_linked: boolean;
  /** Variant archive flag synced from Lightspeed. */
  archived: boolean;
  /** True only when every variant under the same matrix is archived. */
  matrix_archived: boolean;
  /**
   * True when the parent matrix is flagged as a manual (non-RFID) item.
   * For manual rows, `active_epc_count` is the LS on-hand total + settled
   * adjustments instead of an EPC count, and the UI swaps the RFID button
   * for a "Manual" badge.
   */
  is_manual_only: boolean;
  /**
   * Code of a bin that has at least ONE EPC under this SKU pinned to it
   * via the per-EPC "store" pin (items.pinned_bin_id). Null when no EPC
   * is pinned. The catalog row UI shows a green pin icon left of the
   * item name when this is non-null; tooltip says `item in "<code>" bin`.
   * See migration 0082 + the cycle-count scan handler for how the pin
   * gets set.
   */
  pinned_bin_code: string | null;
  /**
   * Variant's color-specific Shopify image (cdn.shopify.com URL), or null
   * when not synced. Rendered as the single picture in the item popup.
   * Populated by lib/server/shopify-catalog-images.ts.
   */
  shopify_image_url: string | null;
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
  manualOnly: boolean,
  stock: string,
  picture: string,
  includeArchived: boolean,
): { sql: string; params: unknown[] } {
  const parts: string[] = ["1=1"];
  const params: unknown[] = [];
  let i = 1;

  /* PICTURES filter — 'with' = only variants that have a synced product image
     (cs.shopify_image_url), 'without' = only those missing one, '' = no filter.
     Narrows the grid like showArchived/manualOnly. */
  if (picture === "with") {
    parts.push(`cs.shopify_image_url IS NOT NULL AND cs.shopify_image_url <> ''`);
  } else if (picture === "without") {
    parts.push(`(cs.shopify_image_url IS NULL OR cs.shopify_image_url = '')`);
  }

  /* Archived visibility (operator request 2026-06-11): the "Show archived"
   * toggle is authoritative in ALL cases, including while searching.
   *  • Default (toggle OFF) → active (non-archived) ONLY — archived never show,
   *    even when a search query is typed.
   *  • Toggle ON → archived ONLY.
   * EXCEPTION — `includeArchived` (mobile scan lookups): resolve ANY item by
   * SKU regardless of archive state. The catalog TABLE hiding archived must
   * NOT break the handheld's "what did I just scan" resolution (it left
   * matrixId empty → the colour picker silently never opened). */
  if (!includeArchived) {
    parts.push(showArchived ? `cs.archived = TRUE` : `cs.archived = FALSE`);
  }

  /* MANUAL ITEMS toolbar toggle — restricts the grid to matrices flagged
     is_manual_only = TRUE. Sister concept to showArchived; both narrow
     the visible rows without changing any other behavior. */
  if (manualOnly || stock === "manual") {
    parts.push(`COALESCE(m.is_manual_only, FALSE) = TRUE`);
  }

  /* STOCK filter — 'in' = at least one live EPC at this location, 'out' = none.
     Mirrors the same location-scoped in-stock subquery used for the displayed
     active_epc_count, so "in stock" here means exactly what the qty badge shows
     for RFID rows (manual rows are handled by the 'manual' branch above). */
  if ((stock === "in" || stock === "out") && locationId.trim().length > 0) {
    params.push(locationId.trim());
    const cmp = stock === "in" ? ">" : "=";
    parts.push(
      `(
        SELECT COUNT(*) FROM items isf
        WHERE isf.custom_sku_id = cs.id
          AND isf.location_id = $${i}::uuid
          AND isf.status = 'in-stock'
      ) ${cmp} 0`,
    );
    i += 1;
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
        OR EXISTS (
          SELECT 1 FROM items ie
          WHERE ie.custom_sku_id = cs.id
            AND ie.epc ILIKE $${i}
        )
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
  default_cost: "cs.default_cost",
  retail_price: "cs.retail_price",
  bin: "bin_location",
  qty_epc: "active_epc_count",
  category: "m.category",
  subcategory_1: "m.subcategory_1",
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
    manualOnly?: boolean;
    stock?: string;
    picture?: string;
    includeArchived?: boolean;
  },
): Promise<CatalogGridResult> {
  const {
    page, limit, q, brand, category, vendor, locationId,
    systemId = "", sortBy = "", sortDir = "", showArchived = false, manualOnly = false,
    stock = "", picture = "", includeArchived = false,
  } = options;
  const safeLimit = Math.min(5000, Math.max(1, limit));
  const offset = Math.max(0, (page - 1) * safeLimit);

  const { sql: whereSql, params: whereParams } = buildWhere(
    q, brand, category, vendor, systemId, locationId, showArchived, manualOnly, stock, picture, includeArchived,
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
    brand: string | null;
    color: string | null;
    size: string | null;
    default_cost: string | null;
    retail_price: string | null;
    category: string | null;
    subcategory_1: string | null;
    ls_on_hand_total: string | null;
    active_epc_count: number;
    bin_location: string | null;
    archived: boolean;
    matrix_archived: boolean;
    is_manual_only: boolean;
    manual_qty: number | null;
    pinned_bin_code: string | null;
    shopify_image_url: string | null;
    shopify_linked: boolean;
  }>(
    `SELECT
       cs.id::text AS custom_sku_id,
       cs.shopify_image_url AS shopify_image_url,
       (cs.shopify_variant_id IS NOT NULL) AS shopify_linked,
       m.id::text AS matrix_id,
       m.ls_system_id::text AS matrix_ls_system_id,
       cs.ls_system_id::text AS sku_ls_system_id,
       cs.sku,
       cs.upc AS sku_upc,
       m.upc AS matrix_upc,
       m.description AS name,
       m.vendor,
       m.brand,
       cs.color_code AS color,
       cs.size,
       cs.default_cost::text AS default_cost,
       cs.retail_price::text AS retail_price,
       m.category AS category,
       m.subcategory_1 AS subcategory_1,
       cs.ls_on_hand_total::text AS ls_on_hand_total,
       cs.archived AS archived,
       bool_and(cs.archived) OVER (PARTITION BY cs.matrix_id) AS matrix_archived,
       COALESCE(m.is_manual_only, FALSE) AS is_manual_only,
       (
         SELECT COUNT(*)::int
         FROM items i
         WHERE i.custom_sku_id = cs.id
           AND i.location_id = $${locIdx}::uuid
           AND i.status = 'in-stock'
       ) AS active_epc_count,
       (
         SELECT miq.current_qty
         FROM manual_item_qty miq
         WHERE miq.custom_sku_id = cs.id
           AND miq.location_id = $${locIdx}::uuid
       ) AS manual_qty,
       (
         SELECT string_agg(DISTINCT b.code, ', ' ORDER BY b.code)
         FROM items i
         INNER JOIN bins b ON b.id = i.bin_id
         WHERE i.custom_sku_id = cs.id
           AND i.location_id = $${locIdx}::uuid
           AND i.status = 'in-stock'
           AND i.bin_id IS NOT NULL
           AND b.archived_at IS NULL
       ) AS bin_location,
       -- "store" pin indicator: first (alphabetically) bin code with a
       -- pinned EPC under this SKU. Null when no EPC is pinned. The UI
       -- shows a green pin icon left of the item name when this is set.
       -- LIMIT 1 + ORDER BY keeps it deterministic if multiple bins are
       -- in play (rare — current spec is store-only).
       (
         SELECT b.code
         FROM items i
         INNER JOIN bins b ON b.id = i.pinned_bin_id
         WHERE i.custom_sku_id = cs.id
           AND i.location_id = $${locIdx}::uuid
           AND i.status = 'in-stock'
           AND i.pinned_bin_id IS NOT NULL
         ORDER BY b.code ASC
         LIMIT 1
       ) AS pinned_bin_code
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

  // Second-pass: overlay settled inventory_adjustments onto active_epc_count for
  // the SKUs we just fetched. Wrapped in try/catch so a missing or broken table
  // never breaks the whole catalog response.
  const adjustmentsBySku = new Map<string, number>();
  if (data.rows.length > 0) {
    const skuIds = data.rows.map((r) => r.custom_sku_id);
    try {
      const adj = await pool.query<{ custom_sku_id: string; delta: string }>(
        `SELECT custom_sku_id::text, COALESCE(SUM(qty_delta), 0)::text AS delta
         FROM inventory_adjustments
         WHERE custom_sku_id = ANY($1::uuid[])
           AND location_id = $2::uuid
           AND state = 'settled'
         GROUP BY custom_sku_id`,
        [skuIds, locationId],
      );
      for (const r of adj.rows) {
        adjustmentsBySku.set(r.custom_sku_id, Number(r.delta) || 0);
      }
    } catch (e) {
      // inventory_adjustments table not yet migrated, or transient DB issue.
      // Don't propagate — catalog should always render.
      console.warn(
        "[inventory_catalog] inventory_adjustments overlay skipped:",
        e instanceof Error ? e.message : e,
      );
    }
  }

  return {
    rows: data.rows.map((row) => {
      const epcCount = Number(row.active_epc_count ?? 0);
      const delta = adjustmentsBySku.get(row.custom_sku_id) ?? 0;
      const lsOnHand = (() => {
        if (row.ls_on_hand_total == null || row.ls_on_hand_total === "") return null;
        const n = Number(row.ls_on_hand_total);
        return Number.isFinite(n) ? n : null;
      })();
      const manual = row.is_manual_only === true;
      // Manual matrices: qty is the absolute value stored in manual_item_qty
      // for this (sku, location). No fallback — if no row exists yet (never
      // synced, never counted) the operator sees 0 until something writes one.
      // RFID matrices: unchanged — EPC count + settled inventory_adjustments delta.
      const displayQty = manual
        ? Number(row.manual_qty ?? 0)
        : epcCount + delta;
      return {
        custom_sku_id: row.custom_sku_id,
        matrix_id: row.matrix_id,
        matrix_ls_system_id: row.matrix_ls_system_id,
        sku_ls_system_id: row.sku_ls_system_id,
        sku: row.sku,
        sku_upc: row.sku_upc,
        matrix_upc: row.matrix_upc,
        name: row.name,
        vendor: row.vendor,
        brand: row.brand,
        color: row.color,
        size: row.size,
        default_cost: row.default_cost,
        retail_price: row.retail_price,
        category: row.category,
        subcategory_1: row.subcategory_1,
        ls_on_hand_total: lsOnHand,
        active_epc_count: displayQty,
        bin_location: row.bin_location ?? null,
        shopify_linked: row.shopify_linked === true,
        archived: row.archived === true,
        matrix_archived: row.matrix_archived === true,
        is_manual_only: manual,
        pinned_bin_code: row.pinned_bin_code ?? null,
        shopify_image_url: row.shopify_image_url ?? null,
      };
    }),
    total,
    brands: filters.brands,
    categories: filters.categories,
    vendors: filters.vendors,
  };
}
