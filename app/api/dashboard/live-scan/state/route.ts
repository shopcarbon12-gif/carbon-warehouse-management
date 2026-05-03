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
 * Counter (`reads_since_start` — kept for response shape compatibility,
 * but it now measures UNIQUE LIVE EPCs, not raw read rows): the count
 * of items currently at status='in-stock' whose last_seen_at fell on or
 * after the session started. That matches the operator's mental model
 * of Live Scan as "count of live tags hit during this session." A tag
 * that comes through the catalog gate as a brand-new in-stock item AND
 * one that was already in-stock and just got re-seen both count once.
 * Duplicates from the same tag re-passing the antenna are deduped at
 * the items level (one row per EPC).
 *
 * Earlier the counter was `count(*) FROM cdm_reads ... ingested_at >= $start`,
 * which counted raw read events — so a single tag scanned 50 times was
 * +50, which inflated the count vs Total Active Inventory.
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
  // items has no tenant_id column directly — scope via locations.
  const r = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM items i
       INNER JOIN locations l ON l.id = i.location_id
      WHERE l.tenant_id = $1::uuid
        AND i.status = 'in-stock'
        AND i.last_seen_at >= $2::timestamptz`,
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
