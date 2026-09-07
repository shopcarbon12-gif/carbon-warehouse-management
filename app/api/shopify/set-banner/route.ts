import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { resolveSetGroupMatrixIds, syncSetBanners } from "@/lib/server/set-banner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Push the "Complete the Look" banner to Shopify for a product and everything
 * else in its set.
 *
 * POST { matrixId } → { ok, results: [{ matrixId, productId, picture, changed }] }
 *
 * The whole group is updated, not just the product asked for: marking one half
 * of an outfit means both halves need the banner, and unticking it means both
 * need it gone.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { matrixId?: string };
  const matrixId = String(body?.matrixId || "").trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });

  const ctx = await resolveShopContext();
  if (!ctx) return NextResponse.json({ error: "Shop not connected." }, { status: 401 });

  try {
    const ids = await resolveSetGroupMatrixIds(pool, matrixId);
    const results = await syncSetBanners(pool, ctx, ids);
    const failed = results.filter((r) => r.error);
    return NextResponse.json({
      ok: failed.length === 0,
      updated: results.filter((r) => r.changed).length,
      results,
      ...(failed.length ? { error: failed.map((f) => f.error).join("; ") } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Banner sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
