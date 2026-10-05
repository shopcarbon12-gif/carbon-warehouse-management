/** One return, with its WMS side (lib/server/shopify-return-desk.ts). Admin only. */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getReturn } from "@/lib/server/shopify-return-desk";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const { id } = await params;
  if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: "Bad return id" }, { status: 400 });
  try {
    return NextResponse.json(await getReturn(pool, id));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load the return." }, { status: 502 });
  }
}
