import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { endSessionForReader } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const { id } = await ctx.params;
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Active-location guard: only mutate when the reader belongs to the
  // caller's current location. Without this, a user signed into FL Mall
  // could pause an Orlando reader.
  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET scan_paused_at = now(),
            scan_paused_by = $3::uuid,
            updated_at = now()
       FROM locations l
      WHERE d.id = $1::uuid
        AND d.location_id = l.id
        AND l.tenant_id = $2::uuid
        AND ($4::uuid IS NULL OR d.location_id = $4::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      RETURNING d.id::text`,
    [id, session.tid, session.sub, session.lid ?? null],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  // Admin Pause is authoritative: force-end any active scan-session on this
  // reader so an operator's open workflow can't keep the reader awake past
  // the click. Without this, scan_paused_at is set but the supervisor's
  // reconcile filter (`!effective_paused || activeScanSessionReaders.has(id)`)
  // keeps the reader scanning until the operator commits/closes.
  const endedScanSession = endSessionForReader(id);
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_pause', 'devices', $3::jsonb)`,
    [
      session.tid,
      session.sub,
      JSON.stringify({ device_id: id, ended_scan_session: endedScanSession }),
    ],
  );
  return NextResponse.json({ ok: true, endedScanSession });
}
