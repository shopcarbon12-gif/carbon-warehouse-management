import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { endSessionForReader } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Scoped to the active location so "Pause all" on FL Mall doesn't reach
  // into Orlando's readers. When session.lid is null the legacy tenant-wide
  // behavior is preserved.
  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET scan_paused_at = COALESCE(d.scan_paused_at, now()),
            scan_paused_by = COALESCE(d.scan_paused_by, $2::uuid),
            updated_at = now()
       FROM locations l
      WHERE d.location_id = l.id
        AND l.tenant_id = $1::uuid
        AND ($3::uuid IS NULL OR d.location_id = $3::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
        AND d.scan_paused_at IS NULL
      RETURNING d.id::text`,
    [session.tid, session.sub, session.lid ?? null],
  );
  // Force-end any in-flight scan-sessions on the readers we just paused, so
  // an operator's open workflow can't keep a reader awake past Pause-All.
  let endedScanSessions = 0;
  for (const row of r.rows) {
    if (endSessionForReader(row.id)) endedScanSessions++;
  }
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_pause_all', 'devices', $3::jsonb)`,
    [
      session.tid,
      session.sub,
      JSON.stringify({
        paused_count: r.rowCount ?? 0,
        ended_scan_sessions: endedScanSessions,
      }),
    ],
  );
  return NextResponse.json({
    ok: true,
    paused: r.rowCount ?? 0,
    endedScanSessions,
  });
}
