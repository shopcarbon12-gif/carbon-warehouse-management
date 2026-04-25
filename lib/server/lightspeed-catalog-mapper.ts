import type { CatalogSyncMatrixPayload, CatalogSyncVariantPayload } from "@/lib/types/catalog-sync";

type LsProduct = {
  id?: string;
  name?: string;
  sku?: string;
  handle?: string;
  variant_parent_id?: string | null;
  has_variants?: boolean;
  variant_options?: { name?: string; value?: string }[];
  product_code?: string;
  barcode?: string;
  brand?: { name?: string } | string;
  supplier?: { name?: string } | string;
  categories?: { name?: string }[];
  /** X-Series: shape varies by account / API version */
  inventory_level?: unknown;
  inventory_in_stock?: unknown;
  stock_on_hand?: unknown;
};

function extractXSeriesOnHand(p: LsProduct): number | null {
  const candidates = [p.inventory_in_stock, p.stock_on_hand];
  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number.parseInt(String(c ?? "").trim(), 10);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const inv = p.inventory_level;
  if (inv && typeof inv === "object" && !Array.isArray(inv)) {
    const o = inv as Record<string, unknown>;
    for (const key of ["available", "quantity", "stock_on_hand", "in_stock"]) {
      const n = Number.parseInt(String(o[key] ?? "").trim(), 10);
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function extractProductsArray(json: unknown): LsProduct[] {
  const root = asRecord(json);
  if (!root) return [];
  const data = root.data;
  if (Array.isArray(data)) return data as LsProduct[];
  const inner = asRecord(data);
  if (inner && Array.isArray(inner.data)) return inner.data as LsProduct[];
  return [];
}

function optionColorSize(vo: LsProduct["variant_options"]): { color: string | null; size: string | null } {
  let color: string | null = null;
  let size: string | null = null;
  if (!Array.isArray(vo)) return { color, size };
  for (const o of vo) {
    const n = (o?.name ?? "").toLowerCase();
    const val = o?.value?.trim() || null;
    if (!val) continue;
    if (n.includes("color") || n.includes("colour")) color = val;
    else if (n.includes("size")) size = val;
  }
  return { color, size };
}

function brandName(p: LsProduct): string | null {
  const b = p.brand;
  if (typeof b === "string") return b.trim() || null;
  if (b && typeof b === "object" && typeof b.name === "string") return b.name.trim() || null;
  return null;
}

function vendorName(p: LsProduct): string | null {
  const s = p.supplier;
  if (typeof s === "string") return s.trim() || null;
  if (s && typeof s === "object" && typeof s.name === "string") return s.name.trim() || null;
  return null;
}

function categoryName(p: LsProduct): string | null {
  const c = p.categories;
  if (Array.isArray(c) && c[0] && typeof c[0].name === "string") return c[0].name.trim() || null;
  return null;
}

/**
 * Maps X-Series `GET /api/2.0/products` JSON into matrix × variant payloads.
 * `hash` converts external ids to 40-bit numeric `ls_system_id` values for RFID encoding.
 */
export function mapLightspeedProductJsonToCatalog(
  json: unknown,
  hash: (input: string) => number,
): CatalogSyncMatrixPayload[] | null {
  const products = extractProductsArray(json);
  if (products.length === 0) return null;

  const byId = new Map<string, LsProduct>();
  for (const p of products) {
    if (p.id) byId.set(String(p.id), p);
  }

  const out: CatalogSyncMatrixPayload[] = [];

  const buildVariant = (p: LsProduct): CatalogSyncVariantPayload => {
    const extId = String(p.id ?? "");
    const { color, size } = optionColorSize(p.variant_options);
    const sku = (p.sku ?? p.handle ?? extId).trim() || `SKU-${hash(extId + ":sku")}`;
    const upc = (p.barcode ?? p.product_code ?? "").trim() || null;
    return {
      lsSystemId: hash(`${extId}:variant`),
      lsItemId: null,
      sku,
      upc,
      color,
      size,
      retailPrice: null,
      onHandTotal: extractXSeriesOnHand(p),
    };
  };

  for (const p of products) {
    const extId = p.id ? String(p.id) : "";
    if (!extId) continue;

    const isChild = Boolean(p.variant_parent_id);
    if (isChild) continue;

    const name = (p.name ?? "Untitled").trim() || "Untitled";
    const parentUpc = (p.barcode ?? p.product_code ?? `UPC-${hash(`${extId}:upc`)}`).trim();

    if (p.has_variants) {
      const children = products.filter((c) => c.variant_parent_id && String(c.variant_parent_id) === extId);
      if (children.length === 0) continue;
      const variants = children.map((c) => buildVariant(c));
      out.push({
        matrixLsSystemId: hash(`${extId}:matrix`),
        description: name,
        brand: brandName(p),
        category: categoryName(p),
        vendor: vendorName(p),
        upc: parentUpc,
        variants,
      });
    } else {
      const v = buildVariant(p);
      out.push({
        matrixLsSystemId: hash(`${extId}:matrix`),
        description: name,
        brand: brandName(p),
        category: categoryName(p),
        vendor: vendorName(p),
        upc: parentUpc,
        variants: [v],
      });
    }
  }

  return out.length ? out : null;
}
