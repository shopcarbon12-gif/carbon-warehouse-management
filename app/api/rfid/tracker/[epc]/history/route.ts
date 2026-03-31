import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listAuditHistoryForEpc } from "@/lib/server/rfid-tracker";

type RouteCtx = { params: Promise<{ epc: string }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { epc: epcParam } = await ctx.params;
  const epc = decodeURIComponent(epcParam);

  const url = new URL(req.url);
  const limit = Math.min(
    200,
    Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "80", 10) || 80),
  );

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const rows = await listAuditHistoryForEpc(pool, session.tid, epc, limit);
    return NextResponse.json({ history: rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[rfid/tracker/history]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
