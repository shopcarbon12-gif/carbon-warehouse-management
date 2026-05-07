import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { endSession } from "@/lib/server/live-scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One-click full-stack reset for a tenant's RFID stack:
 *   1. Stamp recover_requested_at = now() on every cdm_agent at this tenant.
 *      Each agent's next heartbeat (≤30 s) sees the request newer than its
 *      boot_time, exits cleanly, systemd respawns it within RestartSec.
 *      Result: every reader child SIGTERM'd, all supervisor slot state wiped,
 *      port rotation reset, watchdog counters cleared, batch buffer dropped.
 *   2. End the in-memory live-scan session so the dashboard counter restarts
 *      from 0 against a fresh `startedAt`. Operator clicks Live Scan again
 *      (or auto-start fires) to begin a new session.
 *
 * Admin-only, audit-logged. Idempotent — safe to spam.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Scoped to the active location so a hard-reset clicked on FL Mall doesn't
  // signal Orlando's agents to exit. Falls back to tenant-wide when no
  // active location is set on the session.
  const r = await pool.query<{ id: string; name: string }>(
    `UPDATE cdm_agents
        SET recover_requested_at = now(),
            recover_requested_by = $2::uuid,
            updated_at = now()
       WHERE tenant_id = $1::uuid
         AND ($3::uuid IS NULL OR location_id = $3::uuid)
       RETURNING id::text, name`,
    [session.tid, session.sub, session.lid ?? null],
  );

  endSession(session.tid);

  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_hard_reset', 'cdm_agents', $3::jsonb)`,
    [
      session.tid,
      session.sub,
      JSON.stringify({
        agents_signaled: r.rowCount ?? 0,
        agent_names: r.rows.map((row) => row.name),
        live_scan_session_ended: true,
      }),
    ],
  );

  return NextResponse.json({
    ok: true,
    agents_signaled: r.rowCount ?? 0,
    agent_names: r.rows.map((row) => row.name),
    note: "Each agent will exit on its next heartbeat (≤30 s) and respawn within ~5 s. Click Live Scan to start a fresh session.",
  });
}
