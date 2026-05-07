import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listSyncJobLogs } from "@/lib/server/inventory-sync";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    // Scope to active location so users on FL Mall don't see Orlando's sync
    // history.
    const { rows, total } = await listSyncJobLogs(
      pool,
      session.tid,
      page,
      limit,
      session.lid,
    );
    return NextResponse.json(
      { rows, total, page, limit },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[inventory/sync/logs]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
