/** Shopify → Returns list: returns in progress (lib/server/shopify-return-desk.ts). Admin only. */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { listOpenReturns } from "@/lib/server/shopify-return-desk";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  try {
    const rows = await listOpenReturns(pool);
    return NextResponse.json({ rows, count: rows.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load returns." }, { status: 502 });
  }
}
