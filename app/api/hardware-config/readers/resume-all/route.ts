import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET scan_paused_at = NULL,
            scan_paused_by = NULL,
            updated_at = now()
       FROM locations l
      WHERE d.location_id = l.id
        AND l.tenant_id = $1::uuid
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
        AND d.scan_paused_at IS NOT NULL
      RETURNING d.id::text`,
    [session.tid],
  );
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_resume_all', 'devices', $3::jsonb)`,
    [session.tid, session.sub, JSON.stringify({ resumed_count: r.rowCount ?? 0 })],
  );
  return NextResponse.json({ ok: true, resumed: r.rowCount ?? 0 });
}
