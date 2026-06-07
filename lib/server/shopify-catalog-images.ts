import type { Pool } from "pg";
import {
  getShopifyConfig,
  getShopifyAdminToken,
  normalizeShopDomain,
  runShopifyGraphql,
} from "@/lib/shopify";

/**
 * Pull product imagery from Shopify into the catalog, keeping Shopify CDN
 * links verbatim (never re-hosted).
 *
 * Two surfaces consume the result:
 *   • Item popup → one picture per variant = the variant's color-specific
 *     Shopify image (`custom_skus.shopify_image_url`).
 *   • Matrix window → the full Shopify product gallery in Shopify order
 *     (`matrices.shopify_image_urls`, ordered JSONB array of URLs).
 *
 * Matching: a Shopify product is found by the matrix's variant SKUs (the
 * Shopify variant `sku` equals our custom_sku `sku`), falling back to the
 * UPC as a barcode search. Each custom_sku is then matched to its Shopify
 * variant by SKU (case-insensitive) to grab that variant's assigned image.
 *
 * Designed to run one matrix at a time (catalog edit / verify flow) and to
 * be looped over every matrix for a full sweep — see syncShopifyImagesForAll.
 */

type ShopifyMediaImage = { image?: { url?: string | null } | null };
type ShopifyVariantNode = { sku?: string | null; image?: { url?: string | null } | null };
type ShopifyProductNode = {
  id: string;
  title: string;
  featuredImage?: { url?: string | null } | null;
  media?: { nodes?: ShopifyMediaImage[] } | null;
  variants?: { nodes?: ShopifyVariantNode[] } | null;
};
type ProductsResp = { products?: { edges?: { node: ShopifyProductNode }[] } | null };

const PRODUCT_BY_QUERY = /* GraphQL */ `
  query CatalogImagesByQuery($q: String!) {
    products(first: 5, query: $q) {
      edges {
        node {
          id
          title
          featuredImage { url }
          media(first: 50) {
            nodes { ... on MediaImage { image { url } } }
          }
          variants(first: 100) {
            nodes { sku image { url } }
          }
        }
      }
    }
  }
`;

export type MatrixImageSyncResult = {
  matrixId: string;
  upc: string | null;
  description: string;
  ok: boolean;
  reason?: string;
  shopifyProductTitle?: string;
  galleryCount: number;
  variantsMatched: number;
  variantsTotal: number;
};

function dedupePreserveOrder(urls: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const url = (u ?? "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Shopify search escaping: wrap value in quotes, escape backslash + quote. */
function q(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function resolveShopifyAuth(): { shop: string; token: string; apiVersion: string } | null {
  const shop = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN || "");
  if (!shop) return null;
  const token = getShopifyAdminToken(shop);
  if (!token) return null;
  const apiVersion = getShopifyConfig("").apiVersion;
  return { shop, token, apiVersion };
}

async function fetchProductForMatrix(
  auth: { shop: string; token: string; apiVersion: string },
  upc: string | null,
  skus: string[],
): Promise<ShopifyProductNode | null> {
  // Build search terms: variant SKUs first (most precise), then barcode=UPC.
  // Shopify caps query length, so cap the SKU OR-list defensively.
  const skuTerms = skus.slice(0, 40).map((s) => `sku:${q(s)}`);
  const queries: string[] = [];
  if (skuTerms.length) queries.push(skuTerms.join(" OR "));
  if (upc && upc.trim()) queries.push(`barcode:${q(upc.trim())}`);

  for (const search of queries) {
    const res = await runShopifyGraphql<ProductsResp>({
      shop: auth.shop,
      token: auth.token,
      apiVersion: auth.apiVersion,
      query: PRODUCT_BY_QUERY,
      variables: { q: search },
    });
    if (!res.ok || !res.data) continue;
    const edges = res.data.products?.edges ?? [];
    if (!edges.length) continue;
    // If multiple products match, prefer the one whose variants overlap our
    // SKUs the most (handles SKU collisions across products).
    const wantSet = new Set(skus.map((s) => s.toLowerCase()));
    let best: ShopifyProductNode | null = null;
    let bestScore = -1;
    for (const e of edges) {
      const vnodes = e.node.variants?.nodes ?? [];
      const score = vnodes.filter((v) => v.sku && wantSet.has(v.sku.toLowerCase())).length;
      if (score > bestScore) {
        bestScore = score;
        best = e.node;
      }
    }
    if (best) return best;
  }
  return null;
}

/**
 * Sync Shopify imagery for ONE matrix. Returns a structured result; never
 * throws for "no product found" / "no shopify creds" — those come back as
 * ok:false with a reason so callers (scripts, future endpoint) can report.
 */
export async function syncShopifyImagesForMatrix(
  pool: Pool,
  matrixId: string,
): Promise<MatrixImageSyncResult> {
  const m = await pool.query<{ id: string; upc: string | null; description: string }>(
    `SELECT id::text, upc, description FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const matrix = m.rows[0];
  if (!matrix) {
    return {
      matrixId,
      upc: null,
      description: "",
      ok: false,
      reason: "matrix not found",
      galleryCount: 0,
      variantsMatched: 0,
      variantsTotal: 0,
    };
  }

  const csRes = await pool.query<{ id: string; sku: string }>(
    `SELECT id::text, sku FROM custom_skus WHERE matrix_id = $1::uuid`,
    [matrixId],
  );
  const variants = csRes.rows;
  const base = {
    matrixId,
    upc: matrix.upc,
    description: matrix.description,
    galleryCount: 0,
    variantsMatched: 0,
    variantsTotal: variants.length,
  };

  const auth = resolveShopifyAuth();
  if (!auth) {
    return { ...base, ok: false, reason: "Shopify admin token/domain not configured" };
  }

  const product = await fetchProductForMatrix(
    auth,
    matrix.upc,
    variants.map((v) => v.sku),
  );
  if (!product) {
    return { ...base, ok: false, reason: "no matching Shopify product" };
  }

  // Full product gallery (ordered, deduped) → matrix window.
  const galleryUrls = dedupePreserveOrder(
    (product.media?.nodes ?? []).map((n) => n.image?.url),
  );
  const featured =
    (product.featuredImage?.url ?? "").trim() || galleryUrls[0] || null;

  // Map Shopify variant SKU → that variant's assigned image (color image).
  const skuToImage = new Map<string, string>();
  for (const v of product.variants?.nodes ?? []) {
    const sku = (v.sku ?? "").trim().toLowerCase();
    const url = (v.image?.url ?? "").trim();
    if (sku && url) skuToImage.set(sku, url);
  }

  const client = await pool.connect();
  let matched = 0;
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE matrices
          SET shopify_image_urls = $2::jsonb,
              shopify_featured_image_url = $3,
              shopify_images_synced_at = now()
        WHERE id = $1::uuid`,
      [matrixId, JSON.stringify(galleryUrls), featured],
    );
    for (const v of variants) {
      const url = skuToImage.get(v.sku.trim().toLowerCase()) ?? null;
      if (url) matched += 1;
      await client.query(
        `UPDATE custom_skus
            SET shopify_image_url = $2,
                shopify_images_synced_at = now()
          WHERE id = $1::uuid`,
        [v.id, url],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  return {
    ...base,
    ok: true,
    shopifyProductTitle: product.title,
    galleryCount: galleryUrls.length,
    variantsMatched: matched,
  };
}

/** Resolve a matrix id from a UPC (exact match). Null when none/ambiguous-first. */
export async function matrixIdForUpc(pool: Pool, upc: string): Promise<string | null> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text FROM matrices WHERE upc = $1 ORDER BY created_at ASC LIMIT 1`,
    [upc],
  );
  return r.rows[0]?.id ?? null;
}

/**
 * Full sweep — sync every matrix that has at least one variant. Sequential to
 * stay friendly to Shopify's cost budget (the GraphQL client already backs
 * off on THROTTLED). This is the "after verify, adjust to all" entry point.
 */
export async function syncShopifyImagesForAll(
  pool: Pool,
  onProgress?: (r: MatrixImageSyncResult) => void,
): Promise<MatrixImageSyncResult[]> {
  const ids = await pool.query<{ id: string }>(
    `SELECT DISTINCT m.id::text AS id
       FROM matrices m
       JOIN custom_skus cs ON cs.matrix_id = m.id
      ORDER BY 1`,
  );
  const out: MatrixImageSyncResult[] = [];
  for (const { id } of ids.rows) {
    const r = await syncShopifyImagesForMatrix(pool, id);
    out.push(r);
    onProgress?.(r);
  }
  return out;
}
