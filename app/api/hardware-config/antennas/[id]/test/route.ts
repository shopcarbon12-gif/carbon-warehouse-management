import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { ensureAntennaTestSchema } from "@/lib/server/ensure-antenna-test-schema";

/**
 * POST /api/hardware-config/antennas/[id]/test
 *
 * Queues a connection test for the given antenna. The agent picks this up
 * on its next config poll (within 60s), runs a 30-second listen window on
 * the parent reader's binary stream, and POSTs the result to
 * /api/cdm-agents/antenna-test-result. The antenna's status_online is
 * updated from that result.
 *
 * This endpoint just sets the flag and returns. The UI is expected to poll
 * the antenna row until the test completes (max ~90s end-to-end).
 *
 * Admin-scope only.
 */

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await params;

  // Tenant + active-location scoped.
  const r = await pool.query<{ id: string; device_type: string }>(
    `SELECT a.id::text, a.device_type
       FROM devices a
       INNER JOIN locations l ON l.id = a.location_id AND l.tenant_id = $1::uuid
      WHERE a.id = $2::uuid
        AND a.device_type = 'antenna'
        AND ($3::uuid IS NULL OR a.location_id = $3::uuid)`,
    [session.tid, id, session.lid ?? null],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Antenna not found" }, { status: 404 });
  }

  // Self-heal: ensure the schema columns exist before writing. Migrations
  // 033 / 035 should have added these but the migration runner has been
  // failing partway on prod. ensureAntennaTestSchema is IF-NOT-EXISTS and
  // module-cached so it's a no-op on subsequent calls.
  await ensureAntennaTestSchema(pool);

  // Set the pending flag — agent picks it up on next config poll.
  try {
    await pool.query(
      `UPDATE devices SET test_pending_at = now(), updated_at = now()
         WHERE id = $1::uuid`,
      [id],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Database error";
    console.error("[antennas/test]", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    queued: true,
    expectedMaxLatencySec: 90,
  });
}
