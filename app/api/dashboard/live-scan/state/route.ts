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
 * Counter (`reads_since_start`): distinct cdm_reads.epc_hex values
 * posted since the session started, filtered to reads whose EPC passed
 * the tenant's formula (decoded successfully against tenant_epc_config).
 * Each EPC counts once no matter how many times the antenna sees it.
 *
 * Live scan is observational only. The query NEVER touches the items
 * table — it doesn't matter whether a tag has been classified as
 * `in-stock`, `tag_killed`, or doesn't exist in items at all. If the
 * agent saw it and it decoded, it counts. The cycle count and
 * scan-finalize flows are the only places where reads turn into
 * items.status mutations.
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
    `SELECT count(DISTINCT cr.epc_hex)::text AS n
       FROM cdm_reads cr
      WHERE cr.tenant_id = $1::uuid
        AND cr.read_at >= $2::timestamptz
        AND cr.passes_formula = true`,
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
