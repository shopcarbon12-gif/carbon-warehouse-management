import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { linkMatrixToShopify } from "@/lib/server/shopify-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Link one matrix to its existing Shopify product by SKU (backfills the Shopify
 * ids so it's recognised as published without re-creating it). Admin.
 * Body: { matrixId } → { linked, productId, message }
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { matrixId?: string };
  const matrixId = body.matrixId?.trim();
  if (!matrixId) return NextResponse.json({ error: "matrixId required" }, { status: 400 });

  const res = await linkMatrixToShopify(pool, matrixId);
  if (!res.ok) return NextResponse.json({ error: res.message }, { status: 400 });
  return NextResponse.json(res);
}
