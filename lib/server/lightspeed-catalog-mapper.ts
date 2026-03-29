import type { CatalogSyncMatrixPayload, CatalogSyncVariantPayload } from "@/lib/types/catalog-sync";

/** Ten custom SKU lines across multiple matrices for dev / fallback ingestion. */
export function simulateSyncPayload(): CatalogSyncMatrixPayload[] {
  return [
    {
      matrixLsSystemId: 9_001_000_001,
      description: "Mila Mini Dress",
      brand: "Carbon",
      category: "Dresses",
      vendor: "Elementi",
      upc: "810000100001",
      variants: [
        {
          lsSystemId: 9_001_000_011,
          sku: "MILA-BLK-S",
          upc: "810000100011",
          color: "Black",
          size: "S",
          retailPrice: "79.00",
        },
        {
          lsSystemId: 9_001_000_012,
          sku: "MILA-BLK-M",
          upc: "810000100012",
          color: "Black",
          size: "M",
          retailPrice: "79.00",
        },
      ],
    },
    {
      matrixLsSystemId: 9_001_000_002,
      description: "Orlando Linen Blazer",
      brand: "Carbon",
      category: "Outerwear",
      vendor: "Gulf Apparel",
      upc: "810000100020",
      variants: [
        {
          lsSystemId: 9_001_000_021,
          sku: "OLB-NVY-38",
          upc: "810000100021",
          color: "Navy",
          size: "38",
          retailPrice: "148.00",
        },
        {
          lsSystemId: 9_001_000_022,
          sku: "OLB-NVY-40",
          upc: "810000100022",
          color: "Navy",
          size: "40",
          retailPrice: "148.00",
        },
      ],
    },
    {
      matrixLsSystemId: 9_001_000_003,
      description: "Elementi Rib Tank",
      brand: "Elementi",
      category: "Tops",
      vendor: "Elementi",
      upc: "810000100030",
      variants: [
        {
          lsSystemId: 9_001_000_031,
          sku: "ERT-WHT-XS",
          upc: "810000100031",
          color: "White",
          size: "XS",
          retailPrice: "34.00",
        },
        {
          lsSystemId: 9_001_000_032,
          sku: "ERT-WHT-S",
          upc: "810000100032",
          color: "White",
          size: "S",
          retailPrice: "34.00",
        },
      ],
    },
    {
      matrixLsSystemId: 9_001_000_004,
      description: "Carbon RFID Demo Tee",
      brand: "Carbon",
      category: "Basics",
      vendor: "Carbon",
      upc: "810000100040",
      variants: [
        {
          lsSystemId: 9_001_000_041,
          sku: "CRB-DEMO-S",
          upc: "810000100041",
          color: "Heather",
          size: "S",
          retailPrice: "24.00",
        },
        {
          lsSystemId: 9_001_000_042,
          sku: "CRB-DEMO-M",
          upc: "810000100042",
          color: "Heather",
          size: "M",
          retailPrice: "24.00",
        },
      ],
    },
    {
      matrixLsSystemId: 9_001_000_005,
      description: "Florida Mall Capsule Skirt",
      brand: "Carbon",
      category: "Bottoms",
      vendor: "Florida Mall DC",
      upc: "810000100050",
      variants: [
        {
          lsSystemId: 9_001_000_051,
          sku: "FMC-SKT-4",
          upc: "810000100051",
          color: "Sand",
          size: "4",
          retailPrice: "62.00",
        },
        {
          lsSystemId: 9_001_000_052,
          sku: "FMC-SKT-6",
          upc: "810000100052",
          color: "Sand",
          size: "6",
          retailPrice: "62.00",
        },
      ],
    },
  ];
}

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
};

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
      sku,
      upc,
      color,
      size,
      retailPrice: null,
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
