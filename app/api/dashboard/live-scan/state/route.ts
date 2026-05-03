import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { touchSession } from "@/lib/server/live-scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return the tenant's live-scan state AND act as the heartbeat. The
 * dashboard polls this every 2 s while the tile is in RUNNING state;
 * that polling refreshes `lastSeenAt` server-side, keeping the session
 * alive. When the dashboard tab closes, polls stop, the session
 * auto-expires within 60 s, and the agent shuts down all readers.
 *
 * Counter (`reads_since_start`) is `count(*) FROM cdm_reads
 * WHERE tenant_id = $1 AND ingested_at >= $started_at`. The query is
 * fully indexed (cdm_reads has tenant_id + ingested_at indexes) and
 * runs in single-digit ms even at multi-million row scale.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const s = touchSession(session.tid);
  if (!s) {
    return NextResponse.json({
      ok: true,
      active: false,
      session_id: null,
      started_at: null,
      reads_since_start: 0,
    });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json(
      { error: "Database unavailable" },
      { status: 503 },
    );
  }
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM cdm_reads
      WHERE tenant_id = $1::uuid
        AND ingested_at >= $2::timestamptz`,
    [session.tid, new Date(s.startedAt).toISOString()],
  );
  return NextResponse.json({
    ok: true,
    active: true,
    session_id: s.id,
    started_at: new Date(s.startedAt).toISOString(),
    reads_since_start: Number(r.rows[0]?.n ?? 0),
  });
}
