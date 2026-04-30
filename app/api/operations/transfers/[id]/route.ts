import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getTransferDetail } from "@/lib/server/operations-transfers";

/** GET /api/operations/transfers/<uuid> — full RFID + manual contents. */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid transfer id" }, { status: 400 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  try {
    const detail = await getTransferDetail(pool, session.tid, id);
    if (!detail) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[transfers/detail]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
