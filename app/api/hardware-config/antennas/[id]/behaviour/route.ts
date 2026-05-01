import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  /** dBm × 10 — same scale the agent passes to MonsoonReader's `--power`. */
  powerArg: z.coerce.number().int().min(100).max(330),
  readTimeMs: z.coerce.number().int().min(250).max(5000),
  cycleMode: z.enum(["infinite", "oscillating"]),
  tagFocus: z.coerce.boolean(),
});

/**
 * POST /api/hardware-config/antennas/[id]/behaviour
 * Save the operator-tuned radio knobs as the antenna's persistent default.
 * Agent picks up via the regular config-poll within ~60 s.
 *
 * The fields live in devices.config.behaviour (JSONB). Power is also
 * mirrored into devices.transmit_power_dbm because the existing supervisor
 * reads `transmit_power_dbm` for the normal-scan path.
 */
export async function POST(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Tenant ownership: antenna → reader → location → tenant.
  const owns = await pool.query<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM devices a
       INNER JOIN devices r ON r.id = a.parent_device_id
       INNER JOIN locations l ON l.id = r.location_id AND l.tenant_id = $1::uuid
       WHERE a.id = $2::uuid AND a.device_type = 'antenna'`,
    [session.tid, id],
  );
  if (owns.rowCount === 0) {
    return NextResponse.json({ error: "Antenna not in tenant" }, { status: 404 });
  }

  const userId = (session as { uid?: string }).uid ?? null;
  await pool.query(
    `UPDATE devices
       SET transmit_power_dbm = $1::numeric,
           config = jsonb_set(
             COALESCE(config, '{}'::jsonb),
             '{behaviour}',
             jsonb_build_object(
               'read_time_ms', $2::int,
               'cycle_mode',   $3::text,
               'tag_focus',    $4::boolean,
               'saved_at',     to_jsonb(now()),
               'saved_by',     $5::text
             ),
             true
           ),
           updated_at = now()
       WHERE id = $6::uuid`,
    [
      parsed.data.powerArg / 10,
      parsed.data.readTimeMs,
      parsed.data.cycleMode,
      parsed.data.tagFocus,
      userId,
      id,
    ],
  );

  return NextResponse.json({ ok: true });
}
