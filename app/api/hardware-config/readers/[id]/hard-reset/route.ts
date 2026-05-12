import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { endSessionForReader } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-driven per-reader hard reset. Stamps `devices.reader_recover_requested_at`
 * so the CDM agent supervisor's next config-pull (60 s tick) sees a value
 * newer than the slot's spawnedAt and force-recreates the slot — stopSlot
 * (SIGTERM → 10 s → SIGKILL) → ensureRadioStopped → freeSlotIndex → drop
 * from slots map → next reconcile re-allocates with fresh sweep budget.
 *
 * This is the per-reader analog of POST /api/cdm-agents/:id/recover (which
 * restarts the whole agent process). Use this when one reader has wedged
 * its chassis firmware but other readers on the same agent are fine —
 * surgical recovery without disturbing healthy slots.
 *
 * NOT a physical PoE power-cycle. If the WIZnet bridge itself is firmware-
 * wedged, the supervisor's stopSlot + respawn can't clear that — only a
 * physical power-cycle of the reader can. Hard Reset is the strongest
 * soft-reset we have; if it doesn't work, the reader needs a physical
 * power-cycle (or PoE port reset on the switch).
 *
 * Side effect: any active scan-session on this reader is force-ended (same
 * as the Pause click path), so an operator's open Transfer Out / Cycle
 * Count workflow doesn't keep the supervisor from completing the kill.
 */
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

  // Active-location guard + reader-type guard. Stamping reset on a non-
  // reader device would be a silent no-op (agent ignores it), but we'd
  // rather 404 here than confuse the operator.
  const r = await pool.query<{ id: string; name: string; requested_at: string }>(
    `UPDATE devices d
        SET reader_recover_requested_at = now(),
            reader_recover_requested_by = $3::uuid,
            updated_at = now()
       FROM locations l
      WHERE d.id = $1::uuid
        AND d.location_id = l.id
        AND l.tenant_id = $2::uuid
        AND ($4::uuid IS NULL OR d.location_id = $4::uuid)
        AND d.device_type IN ('fixed_reader','transaction_reader','door_reader')
      RETURNING d.id::text,
                d.name,
                d.reader_recover_requested_at::text AS requested_at`,
    [id, session.tid, session.sub, session.lid ?? null],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  const row = r.rows[0]!;
  const endedScanSession = endSessionForReader(id);

  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'cdm_reader_hard_reset', 'devices', $3::jsonb)`,
    [
      session.tid,
      session.sub,
      JSON.stringify({
        device_id: id,
        reader_name: row.name,
        requested_at: row.requested_at,
        ended_scan_session: endedScanSession,
      }),
    ],
  );

  return NextResponse.json({
    ok: true,
    reader_recover_requested_at: row.requested_at,
    endedScanSession,
  });
}
