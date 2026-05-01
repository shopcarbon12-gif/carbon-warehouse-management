import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  listCalibrationPoints,
  saveCalibrationPoint,
} from "@/lib/server/antenna-calibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/antenna-test/calibrate?readerId=…&antennaId=…
 *   List calibration points for one (reader, antenna).
 *
 * POST /api/antenna-test/calibrate
 *   Save a calibration point.
 *   Body: { readerId, antennaId, distanceFt, firstReadPowerArg, referenceEpc, notes? }
 *
 * Both routes are session-cookie authenticated and tenant-scoped.
 */

export async function GET(req: Request) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const readerId = url.searchParams.get("readerId") ?? "";
  const antennaId = url.searchParams.get("antennaId") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(readerId) || !/^[0-9a-f-]{36}$/i.test(antennaId)) {
    return NextResponse.json({ error: "Bad readerId or antennaId" }, { status: 400 });
  }
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const points = await listCalibrationPoints(pool, userSession.tid, readerId, antennaId);
  return NextResponse.json({ points }, { headers: { "Cache-Control": "no-store" } });
}

const saveBody = z.object({
  readerId: z.string().uuid(),
  antennaId: z.string().uuid(),
  distanceFt: z.coerce.number().positive().max(500),
  firstReadPowerArg: z.coerce.number().int().min(100).max(330),
  referenceEpc: z.string().min(1).max(96),
  notes: z.string().max(500).nullable().optional(),
});

export async function POST(req: Request) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = saveBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  // Ownership check: the antenna must belong to the calling user's tenant
  // via reader → location → tenant.
  const owns = await pool.query<{ ok: boolean }>(
    `SELECT TRUE AS ok
       FROM devices a
       INNER JOIN devices r ON r.id = a.parent_device_id AND r.id = $1::uuid
       INNER JOIN locations l ON l.id = r.location_id AND l.tenant_id = $2::uuid
       WHERE a.id = $3::uuid AND a.device_type = 'antenna'`,
    [parsed.data.readerId, userSession.tid, parsed.data.antennaId],
  );
  if (owns.rowCount === 0) {
    return NextResponse.json({ error: "Reader/antenna not in tenant" }, { status: 403 });
  }

  const r = await saveCalibrationPoint(pool, {
    tenantId: userSession.tid,
    readerId: parsed.data.readerId,
    antennaId: parsed.data.antennaId,
    distanceFt: parsed.data.distanceFt,
    firstReadPowerArg: parsed.data.firstReadPowerArg,
    referenceEpc: parsed.data.referenceEpc,
    measuredBy: (userSession as { uid?: string }).uid ?? null,
    notes: parsed.data.notes ?? null,
  });
  return NextResponse.json({ ok: true, id: r.id });
}
