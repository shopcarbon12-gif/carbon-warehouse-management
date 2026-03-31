import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listSimTransferEpcs } from "@/lib/server/operations-transfers";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const loc = url.searchParams.get("locationId")?.trim() || session.lid;
  const limit = Math.min(20, Math.max(1, Number.parseInt(url.searchParams.get("limit") ?? "5", 10) || 5));

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  try {
    const ok = await pool.query(
      `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      [loc, session.tid],
    );
    if (!ok.rows[0]) {
      return NextResponse.json({ error: "Location not found" }, { status: 404 });
    }

    const rows = await listSimTransferEpcs(pool, session.tid, loc, limit);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[operations/transfers/sim-seeds]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
