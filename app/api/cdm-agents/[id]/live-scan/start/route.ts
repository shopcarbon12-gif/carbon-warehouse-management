import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { assertRowLocation } from "@/lib/server/assert-row-location";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/cdm-agents/[id]/live-scan/start
 *
 * Flip a single agent's live_scan_active flag to TRUE, stamp
 * live_scan_last_started_at = now() and live_scan_started_by = caller.
 *
 * Once an agent has been individually started/stopped, the CDM
 * config-poll uses its OWN flag instead of the tenant-wide in-memory
 * session (see lib/server/cdm-agents.ts → getAgentConfigBundle). The
 * tenant-wide dashboard mass-toggle is unaffected for OTHER agents.
 *
 * Auth: session cookie. Location guard: the agent's location_id must
 * match the caller's active session.lid (so a manager at store A can't
 * toggle a reader at store B).
 *
 * Response: { ok: true, agent_id, live_scan_active, last_started_at, started_by }
 *           { error } on 401 / 403 / 404 / 500.
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

  const r = await pool.query<{
    id: string;
    live_scan_active: boolean;
    live_scan_last_started_at: string | null;
    live_scan_started_by: string | null;
  }>(
    `UPDATE cdm_agents
        SET live_scan_active = TRUE,
            live_scan_last_started_at = now(),
            live_scan_started_by = $2::uuid,
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING id::text,
                live_scan_active,
                live_scan_last_started_at::text AS live_scan_last_started_at,
                live_scan_started_by::text AS live_scan_started_by`,
    [id, session.sub ?? null],
  );
  const row = r.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    agent_id: row.id,
    live_scan_active: row.live_scan_active,
    last_started_at: row.live_scan_last_started_at,
    started_by: row.live_scan_started_by,
  });
}
