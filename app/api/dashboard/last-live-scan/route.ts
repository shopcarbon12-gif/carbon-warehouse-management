import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Returns the most recently completed live-scan session for this tenant.
 * The Dashboard's "Last Scan" PulsePill consumes this — the live Live Scan
 * widget moved to Hardware Config. Returns NULL fields when no scan has
 * ever been recorded for the tenant.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const r = await pool.query<{
    id: string;
    started_at: string;
    ended_at: string;
    unique_epc_count: number;
    end_reason: string;
  }>(
    `SELECT id::text,
            started_at::text,
            ended_at::text,
            unique_epc_count,
            end_reason
       FROM live_scan_sessions
       WHERE tenant_id = $1::uuid
       ORDER BY ended_at DESC
       LIMIT 1`,
    [session.tid],
  );
  if (r.rowCount === 0) {
    return NextResponse.json(
      { last_scan: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { last_scan: r.rows[0] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
