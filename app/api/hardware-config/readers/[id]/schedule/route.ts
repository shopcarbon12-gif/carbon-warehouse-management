import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { validateSchedule } from "@/lib/server/scan-schedule";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * PATCH body: either a full schedule object (validateSchedule shape) OR
 * `{ schedule: null }` to remove an existing schedule.
 */
export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const wrapper = body as { schedule?: unknown };
  let nextValue: string | null;
  try {
    if (wrapper.schedule === null) {
      nextValue = null;
    } else {
      const validated = validateSchedule(wrapper.schedule);
      nextValue = JSON.stringify(validated);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid schedule";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Active-location guard.
  const r = await pool.query<{ id: string }>(
    `UPDATE devices d
        SET scan_schedule = $3::jsonb,
            updated_at = now()
       FROM locations l
      WHERE d.id = $1::uuid
        AND d.location_id = l.id
        AND l.tenant_id = $2::uuid
        AND ($4::uuid IS NULL OR d.location_id = $4::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      RETURNING d.id::text`,
    [id, session.tid, nextValue, session.lid ?? null],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_schedule_changed', 'devices', $3::jsonb)`,
    [session.tid, session.sub, JSON.stringify({ device_id: id, schedule: nextValue })],
  );
  return NextResponse.json({ ok: true });
}
