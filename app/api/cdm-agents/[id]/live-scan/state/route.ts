import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { assertRowLocation } from "@/lib/server/assert-row-location";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/cdm-agents/[id]/live-scan/state
 *
 * Read a single agent's live-scan state (and a coarse online-ish signal
 * for any one of its fixed/transaction/door readers — useful for the
 * companion POS app to confirm the reader is actually responding).
 *
 * Auth: session cookie. Location guard: agent's location must match
 * session.lid.
 *
 * Response:
 *   {
 *     agent_id, live_scan_active, last_started_at, started_by,
 *     reader_status_online // true if ANY reader bound to this agent
 *                          // currently reports status_online=true
 *   }
 */
export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid agent id" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const check = await assertRowLocation(pool, "cdm_agents", id, session.tid, session.lid);
  if (check === "not_found") {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (check === "wrong_location") {
    return NextResponse.json(
      { error: "Agent is at a different location than your active one" },
      { status: 403 },
    );
  }

  const r = await pool.query<{
    id: string;
    live_scan_active: boolean;
    live_scan_last_started_at: string | null;
    live_scan_started_by: string | null;
    reader_status_online: boolean;
  }>(
    `SELECT a.id::text,
            a.live_scan_active,
            a.live_scan_last_started_at::text AS live_scan_last_started_at,
            a.live_scan_started_by::text AS live_scan_started_by,
            COALESCE(bool_or(d.status_online), false) AS reader_status_online
       FROM cdm_agents a
       LEFT JOIN devices d
         ON d.cdm_agent_id = a.id
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      WHERE a.id = $1::uuid
      GROUP BY a.id`,
    [id],
  );
  const row = r.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({
    agent_id: row.id,
    live_scan_active: row.live_scan_active === true,
    last_started_at: row.live_scan_last_started_at,
    started_by: row.live_scan_started_by,
    reader_status_online: row.reader_status_online === true,
  });
}
