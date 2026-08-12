import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { runShopifyGraphql, toProductGid } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Write optimized SEO back to Shopify (productUpdate: seo/title/handle/
 * descriptionHtml/tags), plus image alt text, a 301 redirect on handle change,
 * and the carbon_seo optimized marker. Also stamps matrices.seo_optimized_at.
 * Ported from carbon-gen; auth = WMS session+admin. Body: { productId,
 * matrixId?, fields, oldHandle?, markOptimized? }.
 */
interface PublishFields {
  seoTitle?: string;
  metaDescription?: string;
  handle?: string;
  title?: string;
  bodyHtml?: string;
  tags?: string[];
  productType?: string;
  vendor?: string;
  imageAlts?: Array<{ id: string; altText: string }>;
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
  const fields: PublishFields = body?.fields || {};
  const oldHandle = String(body?.oldHandle || "").trim();
  if (!productId) return NextResponse.json({ error: "Missing productId." }, { status: 400 });

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });
  const { shop, token, apiVersion } = ctx;

  const input: Record<string, unknown> = { id: productId };
  const seo: Record<string, string> = {};
  if (typeof fields.seoTitle === "string") seo.title = fields.seoTitle.trim();
  if (typeof fields.metaDescription === "string") seo.description = fields.metaDescription.trim();
  if (Object.keys(seo).length) input.seo = seo;
  if (typeof fields.title === "string" && fields.title.trim()) input.title = fields.title.trim();
  if (typeof fields.handle === "string" && fields.handle.trim()) input.handle = fields.handle.trim().toLowerCase();
  if (typeof fields.bodyHtml === "string") input.descriptionHtml = fields.bodyHtml;
  if (typeof fields.productType === "string") input.productType = fields.productType.trim();
  if (typeof fields.vendor === "string") input.vendor = fields.vendor.trim();
  if (Array.isArray(fields.tags)) {
    input.tags = fields.tags.map((t) => String(t || "").trim()).filter(Boolean);
  }

  const updatedFields: string[] = [];
  const hasProductUpdate = Object.keys(input).length > 1;

  if (hasProductUpdate) {
    const result = await runShopifyGraphql<{
      productUpdate?: { userErrors?: Array<{ field: string[]; message: string }> };
    }>({
      shop,
      token,
      apiVersion,
      query: `mutation UpdateProduct($input: ProductInput!) {
        productUpdate(input: $input) { product { id handle } userErrors { field message } }
      }`,
      variables: { input },
    });
    const userErrors = result.data?.productUpdate?.userErrors || [];
    if (!result.ok || result.errors || userErrors.length) {
      return NextResponse.json(
        { error: "Shopify product update failed", details: result.errors || userErrors },
        { status: result.status === 429 ? 429 : 400 },
      );
    }
    updatedFields.push(...Object.keys(input).filter((k) => k !== "id"));
  }

  // 301 redirect when the handle changed.
  let redirectCreated = false;
  const newHandle = typeof input.handle === "string" ? (input.handle as string) : "";
  if (newHandle && oldHandle && newHandle !== oldHandle.toLowerCase()) {
    const r = await runShopifyGraphql<{ urlRedirectCreate?: { userErrors?: Array<{ message: string }> } }>({
      shop,
      token,
      apiVersion,
      query: `mutation CreateRedirect($redirect: UrlRedirectInput!) {
        urlRedirectCreate(urlRedirect: $redirect) { urlRedirect { id } userErrors { field message } }
      }`,
      variables: { redirect: { path: `/products/${oldHandle}`, target: `/products/${newHandle}` } },
    });
    redirectCreated = Boolean(r.ok && !(r.data?.urlRedirectCreate?.userErrors || []).length);
  }

  // Image alt text (batched).
  const altResults: { updated: number; errors: string[] } = { updated: 0, errors: [] };
  const alts = (fields.imageAlts || [])
    .map((a) => ({ id: String(a?.id || "").trim(), alt: String(a?.altText || "").trim() }))
    .filter((a) => a.id.startsWith("gid://shopify/MediaImage/"));
  if (alts.length) {
    const media = alts.map((a) => ({ id: a.id, alt: a.alt ? a.alt : null }));
    const r = await runShopifyGraphql<{ productUpdateMedia?: { mediaUserErrors?: Array<{ message: string }> } }>({
      shop,
      token,
      apiVersion,
      query: `mutation ProductUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
        productUpdateMedia(productId: $productId, media: $media) {
          media { ... on MediaImage { id alt } } mediaUserErrors { field message }
        }
      }`,
      variables: { productId, media },
    });
    const errs = r.data?.productUpdateMedia?.mediaUserErrors || [];
    if (!r.ok || r.errors || errs.length) {
      altResults.errors.push(...errs.map((e: { message: string }) => e.message));
    } else {
      altResults.updated = alts.length;
      updatedFields.push("imageAlts");
    }
  }

  // Mark optimized (Shopify metafield + WMS timestamp).
  let optimizedMarked = false;
  if (body?.markOptimized === true) {
    const stamp = new Date().toISOString();
    const mr = await runShopifyGraphql<{ metafieldsSet?: { userErrors?: Array<{ message: string }> } }>({
      shop,
      token,
      apiVersion,
      query: `mutation SetOptimized($m: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $m) { userErrors { field message } }
      }`,
      variables: {
        m: [
          {
            ownerId: productId,
            namespace: "carbon_seo",
            key: "optimized_at",
            type: "single_line_text_field",
            value: stamp,
          },
        ],
      },
    });
    optimizedMarked = Boolean(mr.ok && !(mr.data?.metafieldsSet?.userErrors || []).length);
    if (matrixId) {
      await pool
        .query(`UPDATE matrices SET seo_optimized_at = now() WHERE id = $1::uuid`, [matrixId])
        .catch(() => {});
    }
    if (optimizedMarked) updatedFields.push("optimized-flag");
  }

  if (!updatedFields.length && !redirectCreated) {
    return NextResponse.json({ error: "No fields provided to publish." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, updatedFields, redirectCreated, altResults, optimizedMarked });
}
