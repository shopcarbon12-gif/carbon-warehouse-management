import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { runShopifyGraphql, toProductGid } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { scoreAll } from "@/lib/seo/deterministic";
import type { ProductContext, SeoFields } from "@/lib/seo/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read a product's current Shopify SEO (title/meta/description/tags/image alts)
 * + context, and score it. Ported from carbon-gen; auth = WMS session+admin,
 * shop/token from resolveShopContext. Body: { productId } (a gid or numeric).
 */
const PRODUCT_FIELDS = `
  id title handle descriptionHtml productType vendor tags onlineStoreUrl
  seo { title description }
  priceRangeV2 { minVariantPrice { amount currencyCode } }
  media(first: 50) { nodes { ... on MediaImage { id image { url altText } } } }
  variants(first: 50) { nodes { id sku barcode price selectedOptions { name value } } }
`;

interface AuditProduct {
  id: string;
  title: string;
  handle: string;
  descriptionHtml: string | null;
  productType: string | null;
  vendor: string | null;
  tags: string[] | null;
  onlineStoreUrl: string | null;
  seo: { title: string | null; description: string | null } | null;
  priceRangeV2?: { minVariantPrice?: { amount?: string; currencyCode?: string } };
  media?: { nodes: Array<{ id?: string; image?: { url?: string; altText?: string | null } }> };
  variants?: {
    nodes: Array<{
      id: string;
      sku?: string | null;
      barcode?: string | null;
      price?: string | null;
      selectedOptions?: Array<{ name?: string | null; value?: string | null }>;
    }>;
  };
}

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = await req.json().catch(() => ({}));
  const productId = toProductGid(String(body?.productId || ""));
  const matrixId = String(body?.matrixId || "").trim();
  if (!productId) return NextResponse.json({ error: "Missing productId." }, { status: 400 });

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  const result = await runShopifyGraphql<{ product?: AuditProduct }>({
    shop: ctx.shop,
    token: ctx.token,
    apiVersion: ctx.apiVersion,
    query: `query Audit($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`,
    variables: { id: productId },
  });
  if (!result.ok || result.errors) {
    return NextResponse.json(
      { error: "Shopify GraphQL error", details: result.errors },
      { status: result.status === 429 ? 429 : 400 },
    );
  }
  const product = result.data?.product;
  if (!product) {
    // Self-heal: the stored Shopify product was deleted. Clear the stale link so
    // the product shows as unlinked and can be re-linked or re-published.
    if (matrixId) {
      await pool
        .query(
          `UPDATE matrices SET shopify_product_id = NULL, shopify_sync_status = NULL WHERE id = $1::uuid`,
          [matrixId],
        )
        .catch(() => {});
      await pool
        .query(
          `UPDATE custom_skus SET shopify_variant_id = NULL, shopify_inventory_item_id = NULL WHERE matrix_id = $1::uuid`,
          [matrixId],
        )
        .catch(() => {});
    }
    return NextResponse.json(
      {
        error: "This product no longer exists on Shopify — the link was cleared. Re-link (🔗) or Check & Publish it.",
        code: "STALE_LINK",
      },
      { status: 404 },
    );
  }

  const mediaNodes = (product.media?.nodes || []).filter((n) => n && n.id);
  const variantNodes = product.variants?.nodes || [];

  const fields: SeoFields = {
    title: product.title || "",
    seoTitle: product.seo?.title || "",
    metaDescription: product.seo?.description || "",
    handle: product.handle || "",
    bodyHtml: product.descriptionHtml || "",
    tags: product.tags || [],
    productType: product.productType || "",
    vendor: product.vendor || "",
    imageAlts: mediaNodes.map((n) => ({
      id: String(n.id || ""),
      url: String(n.image?.url || ""),
      altText: String(n.image?.altText || ""),
    })),
  };

  const context: ProductContext = {
    productId: product.id,
    handle: product.handle || "",
    title: product.title || "",
    productType: product.productType || "",
    vendor: product.vendor || "",
    tags: product.tags || [],
    price: product.priceRangeV2?.minVariantPrice?.amount || undefined,
    currency: product.priceRangeV2?.minVariantPrice?.currencyCode || undefined,
    variantSkus: variantNodes.map((v) => String(v.sku || "")).filter(Boolean).slice(0, 10),
    barcodes: variantNodes.map((v) => String(v.barcode || "")).filter(Boolean).slice(0, 10),
    colors: Array.from(
      new Set(
        variantNodes
          .flatMap((v) => v.selectedOptions || [])
          .filter((o) => /colou?r/i.test(String(o?.name || "")))
          .map((o) => String(o?.value || "").trim())
          .filter(Boolean),
      ),
    ).slice(0, 12),
    imageCount: mediaNodes.length,
    onlineStoreUrl: product.onlineStoreUrl || undefined,
  };

  return NextResponse.json({
    product: { id: product.id, title: product.title, onlineStoreUrl: product.onlineStoreUrl },
    current: fields,
    context,
    scorecard: scoreAll(fields),
  });
}
