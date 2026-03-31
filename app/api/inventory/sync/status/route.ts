import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getSyncStatusSummary } from "@/lib/server/inventory-sync";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const summary = await getSyncStatusSummary(pool, session.tid);
    return NextResponse.json(summary, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[inventory/sync/status]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
