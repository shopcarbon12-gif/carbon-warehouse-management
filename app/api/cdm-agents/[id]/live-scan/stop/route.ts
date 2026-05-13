import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { assertRowLocation } from "@/lib/server/assert-row-location";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/cdm-agents/[id]/live-scan/stop
 *
 * Flip a single agent's live_scan_active to FALSE. Leaves
 * live_scan_last_started_at intact so the config-poll continues to use
 * the per-agent flag (the agent has been "managed" — its history of
 * individual control persists, including the stopped state).
 *
 * Auth: session cookie. Location guard: agent's location must match
 * session.lid.
 *
 * Response: { ok: true, agent_id, live_scan_active }
 */
export async function POST(req: Request, { params }: Ctx) {
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

  const r = await pool.query<{ id: string; live_scan_active: boolean }>(
    `UPDATE cdm_agents
        SET live_scan_active = FALSE,
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING id::text, live_scan_active`,
    [id],
  );
  const row = r.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    agent_id: row.id,
    live_scan_active: row.live_scan_active,
  });
}
