import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";

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
  // caller's current location.
  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET scan_paused_at = NULL,
            scan_paused_by = NULL,
            updated_at = now()
       FROM locations l
      WHERE d.id = $1::uuid
        AND d.location_id = l.id
        AND l.tenant_id = $2::uuid
        AND ($3::uuid IS NULL OR d.location_id = $3::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      RETURNING d.id::text`,
    [id, session.tid, session.lid ?? null],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_resume', 'devices', $3::jsonb)`,
    [session.tid, session.sub, JSON.stringify({ device_id: id })],
  );
  return NextResponse.json({ ok: true });
}
