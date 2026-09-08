import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { runShopifyGraphql, toProductGid } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { applySetBanner, pictureForProduct } from "@/lib/seo/setNotice";

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
  /** The keyword the copy was written around — see the metafield block below. */
  focusKeyword?: string;
  secondaryKeywords?: string[];
  /** Score of the exact field set being published, as shown to the user. */
  score?: number;
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
  /* Filled in from the productUpdate response so the redirect can point at the
     handle that actually exists. */
  let assignedHandle = "";
  const seo: Record<string, string> = {};
  if (typeof fields.seoTitle === "string") seo.title = fields.seoTitle.trim();
  if (typeof fields.metaDescription === "string") seo.description = fields.metaDescription.trim();
  if (Object.keys(seo).length) input.seo = seo;
  if (typeof fields.title === "string" && fields.title.trim()) input.title = fields.title.trim();
  if (typeof fields.handle === "string" && fields.handle.trim()) input.handle = fields.handle.trim().toLowerCase();
  if (typeof fields.bodyHtml === "string") {
    /*
     * Re-attach the "Complete the Look" banner.
     *
     * The optimizer strips it so the model never sees boilerplate, which means
     * publishing the generated copy verbatim would take the banner off every set
     * product the moment its SEO was refreshed. Rebuilding it here from the
     * product's own SKU numbering keeps the two features from undoing each
     * other, and costs one small query.
     */
    let picture: 1 | 2 | null = null;
    try {
      const where = matrixId ? "m.id = $1::uuid" : "m.shopify_product_id = $1";
      const r = await pool.query<{ upc: string | null; is_set: boolean; skus: string[] | null }>(
        `SELECT m.upc, m.is_set, array_agg(cs.sku) FILTER (WHERE cs.sku IS NOT NULL) AS skus
           FROM matrices m
           LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
          WHERE ${where}
          GROUP BY m.id`,
        [matrixId || productId],
      );
      const row = r.rows[0];
      if (row?.is_set) picture = pictureForProduct(row.skus || [], row.upc);
    } catch {
      /* A lookup failure must not block the SEO write; the banner is restored
         by the next set push. */
    }
    input.descriptionHtml = applySetBanner(fields.bodyHtml, picture);
  }
  if (typeof fields.productType === "string") input.productType = fields.productType.trim();
  if (typeof fields.vendor === "string") input.vendor = fields.vendor.trim();
  if (Array.isArray(fields.tags)) {
    input.tags = fields.tags.map((t) => String(t || "").trim()).filter(Boolean);
  }

  const updatedFields: string[] = [];
  const hasProductUpdate = Object.keys(input).length > 1;

  if (hasProductUpdate) {
    const result = await runShopifyGraphql<{
      productUpdate?: {
        product?: { id: string; handle: string };
        userErrors?: Array<{ field: string[]; message: string }>;
      };
    }>({
      shop,
      token,
      apiVersion,
      query: `mutation UpdateProduct($input: ProductInput!) {
        productUpdate(input: $input) { product { id handle } userErrors { field message } }
      }`,
      variables: { input },
    });
    assignedHandle = result.data?.productUpdate?.product?.handle || "";
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
  //
  // The target is the handle Shopify actually assigned, not the one we asked
  // for. When the clean handle is already taken Shopify silently appends a
  // suffix, and redirecting to the handle we requested would point every old
  // link at a 404.
  let redirectCreated = false;
  const assigned = String(assignedHandle || "").trim();
  const newHandle = assigned || (typeof input.handle === "string" ? (input.handle as string) : "");
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

  /*
   * Mark optimized, and record the focus keyword.
   *
   * The keyword is not decoration: the scorer checks seoTitle, metaDescription
   * and bodyHtml for it, which is over half the total weighting. It used to be
   * generated during optimization and then thrown away at publish, so every
   * later audit had nothing to check against and scored those three fields as
   * failures no matter how good the copy was — a product that genuinely earned
   * 100 read 89 the moment it was reopened, and re-running the optimizer would
   * regenerate copy that was already correct. Persisting it here is what makes
   * the score reproducible.
   */
  let optimizedMarked = false;
  const focusKeyword = String(fields.focusKeyword || "").trim();
  const secondaryKeywords = Array.isArray(fields.secondaryKeywords)
    ? fields.secondaryKeywords.map((s) => String(s || "").trim()).filter(Boolean).slice(0, 8)
    : [];
  const score = Number(fields.score);

  if (body?.markOptimized === true || focusKeyword) {
    const stamp = new Date().toISOString();
    const metafields: Array<Record<string, string>> = [];
    if (body?.markOptimized === true) {
      metafields.push({
        ownerId: productId,
        namespace: "carbon_seo",
        key: "optimized_at",
        type: "single_line_text_field",
        value: stamp,
      });
    }
    if (focusKeyword) {
      metafields.push({
        ownerId: productId,
        namespace: "carbon_seo",
        key: "focus_keyword",
        type: "single_line_text_field",
        value: focusKeyword,
      });
    }
    if (secondaryKeywords.length) {
      metafields.push({
        ownerId: productId,
        namespace: "carbon_seo",
        key: "secondary_keywords",
        type: "list.single_line_text_field",
        value: JSON.stringify(secondaryKeywords),
      });
    }
    if (Number.isFinite(score) && score > 0) {
      metafields.push({
        ownerId: productId,
        namespace: "carbon_seo",
        key: "score",
        type: "number_integer",
        value: String(Math.round(score)),
      });
    }

    const mr = await runShopifyGraphql<{ metafieldsSet?: { userErrors?: Array<{ message: string }> } }>({
      shop,
      token,
      apiVersion,
      query: `mutation SetOptimized($m: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $m) { userErrors { field message } }
      }`,
      variables: { m: metafields },
    });
    optimizedMarked = Boolean(mr.ok && !(mr.data?.metafieldsSet?.userErrors || []).length);
    if (matrixId && body?.markOptimized === true) {
      await pool
        .query(`UPDATE matrices SET seo_optimized_at = now() WHERE id = $1::uuid`, [matrixId])
        .catch(() => {});
    }
    if (optimizedMarked) {
      updatedFields.push(body?.markOptimized === true ? "optimized-flag" : "focus-keyword");
    }
  }

  if (!updatedFields.length && !redirectCreated) {
    return NextResponse.json({ error: "No fields provided to publish." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, updatedFields, redirectCreated, altResults, optimizedMarked });
}
