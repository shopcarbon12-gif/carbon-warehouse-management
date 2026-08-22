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
 * Resolve a linked product's public storefront ("View online") URL.
 * GET ?matrixId= → { url }  — Shopify onlineStoreUrl, or primaryDomain/products/<handle>.
 * Returns code STALE_LINK (404) + clears the link if the Shopify product is gone.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const matrixId = new URL(req.url).searchParams.get("matrixId")?.trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });

  const mr = await pool.query<{ shopify_product_id: string | null }>(
    `SELECT shopify_product_id FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const pid = mr.rows[0]?.shopify_product_id;
  if (!pid) return NextResponse.json({ error: "This product isn't linked to Shopify." }, { status: 422 });

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  const gid = toProductGid(pid);
  const result = await runShopifyGraphql<{
    product?: { onlineStoreUrl?: string | null; handle?: string | null } | null;
    shop?: { primaryDomain?: { url?: string | null } | null } | null;
  }>({
    shop: ctx.shop,
    token: ctx.token,
    apiVersion: ctx.apiVersion,
    query: `query ProductUrl($id: ID!) {
      product(id: $id) { onlineStoreUrl handle }
      shop { primaryDomain { url } }
    }`,
    variables: { id: gid },
  });
  if (!result.ok || result.errors) {
    return NextResponse.json(
      { error: "Shopify error resolving the storefront URL." },
      { status: result.status === 429 ? 429 : 400 },
    );
  }

  const product = result.data?.product;
  if (!product) {
    // Self-heal: the Shopify product was deleted — clear the stale link.
    await pool
      .query(`UPDATE matrices SET shopify_product_id = NULL, shopify_sync_status = NULL WHERE id = $1::uuid`, [matrixId])
      .catch(() => {});
    await pool
      .query(`UPDATE custom_skus SET shopify_variant_id = NULL, shopify_inventory_item_id = NULL WHERE matrix_id = $1::uuid`, [matrixId])
      .catch(() => {});
    return NextResponse.json(
      { error: "This product no longer exists on Shopify — the link was cleared.", code: "STALE_LINK" },
      { status: 404 },
    );
  }

  const domain = (result.data?.shop?.primaryDomain?.url || "").replace(/\/+$/, "");
  const url =
    product.onlineStoreUrl ||
    (product.handle && domain ? `${domain}/products/${product.handle}` : null);
  if (!url) {
    return NextResponse.json(
      { error: "This product isn't published to the online store yet." },
      { status: 409 },
    );
  }
  return NextResponse.json({ url });
}
