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
 * Flip a whole matrix's Shopify product status (ACTIVE | DRAFT | ARCHIVED).
 * status is a PRODUCT-level attribute, so one productUpdate covers every
 * colour×size variant at once. POST { matrixId, status } → { ok, status }.
 * Note: a later ✔ Check & Publish re-forces ACTIVE (productSet), so this is a
 * manual take-offline that publish reverses.
 */
const ALLOWED = new Set(["ACTIVE", "DRAFT", "ARCHIVED"]);

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  let body: { matrixId?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const matrixId = body.matrixId?.trim();
  const status = String(body.status || "").trim().toUpperCase();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });
  if (!ALLOWED.has(status)) {
    return NextResponse.json({ error: "status must be ACTIVE, DRAFT, or ARCHIVED" }, { status: 400 });
  }

  const mr = await pool.query<{ shopify_product_id: string | null }>(
    `SELECT shopify_product_id FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const pid = mr.rows[0]?.shopify_product_id;
  if (!pid) return NextResponse.json({ error: "This product isn't linked to Shopify." }, { status: 422 });

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  const result = await runShopifyGraphql<{
    productUpdate?: {
      product?: { id: string; status: string } | null;
      userErrors?: Array<{ field?: string[]; message: string }>;
    };
  }>({
    shop: ctx.shop,
    token: ctx.token,
    apiVersion: ctx.apiVersion,
    query: `mutation SetStatus($input: ProductInput!) {
      productUpdate(input: $input) { product { id status } userErrors { field message } }
    }`,
    variables: { input: { id: toProductGid(pid), status } },
  });

  const userErrors: Array<{ message: string }> = result.data?.productUpdate?.userErrors ?? [];
  if (!result.ok || userErrors.length) {
    return NextResponse.json(
      { error: userErrors.map((e) => e.message).join("; ") || "Shopify rejected the status change." },
      { status: result.status === 429 ? 429 : 400 },
    );
  }
  return NextResponse.json({ ok: true, status: result.data?.productUpdate?.product?.status ?? status });
}
