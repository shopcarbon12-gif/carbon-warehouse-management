import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { listSyncJobLogs } from "@/lib/server/inventory-sync";

export async function GET(req: Request) {
  const session = await getSession();
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
    const { rows, total } = await listSyncJobLogs(pool, session.tid, page, limit);
    return NextResponse.json(
      { rows, total, page, limit },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[inventory/sync/logs]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
