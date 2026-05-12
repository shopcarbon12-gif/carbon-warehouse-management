import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  createSession,
  type AntennaTestFlags,
} from "@/lib/server/antenna-test-sessions";
import { publishAntennaTestLifecycle } from "@/lib/server/antenna-test-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-only RAW reader-test session. Differs from /api/antenna-test/start
 * in three ways:
 *
 *   1. Keyed by readerId + antennaNumber (not antennaId). Survives readers
 *      whose antenna child rows aren't fully configured — the operator's
 *      whole point is "my readers aren't set up the same, prove the chip
 *      itself is alive without WMS getting in the way."
 *   2. Power floor relaxed from 100 (10 dBm) to 0 (0 dBm), ceiling stays
 *      at 330 (33 dBm — verified safe on .18/.22).
 *   3. Marks the session rawMode:true. The shared antenna-test ingest +
 *      stop routes honor this flag to skip ALL writes (last_read_at,
 *      last_test_passed). The diagnostic leaves zero DB trace.
 *
 * Driver is still console-only — see monsoon-supervisor.ts:1130. Changing
 * that requires an agent rebuild; out of scope for this MVP.
 */
const bodySchema = z.object({
  readerId: z.string().uuid(),
  antennaNumber: z.coerce.number().int().min(1).max(32),
  /** dBm 0..33 — UI exposes the natural unit, server converts to dBm×10. */
  powerDbm: z.coerce.number().min(0).max(33),
  readTimeMs: z.coerce.number().int().min(250).max(5000).default(1000),
  cycleMode: z.enum(["infinite", "oscillating"]).default("infinite"),
  tagFocus: z.coerce.boolean().default(false),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

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

  // Resolve reader + location + tenant. The reader must exist and belong
  // to the calling tenant. Antenna row is OPTIONAL — if missing we still
  // run the test (the agent uses antennaNumber for the binary's `--ant`
  // arg, not the WMS antenna UUID). When no antenna row exists we just
  // generate a placeholder UUID; the rawMode flag ensures no UPDATE ever
  // touches it.
  const r = await pool.query<{
    reader_id: string;
    location_id: string;
    tenant_id: string;
    antenna_id: string | null;
  }>(
    `SELECT
       r.id::text          AS reader_id,
       r.location_id::text AS location_id,
       l.tenant_id::text   AS tenant_id,
       (
         SELECT a.id::text FROM devices a
         WHERE a.parent_device_id = r.id
           AND a.device_type = 'antenna'
           AND (a.config->>'antenna_number')::int = $2::int
         LIMIT 1
       ) AS antenna_id
     FROM devices r
     INNER JOIN locations l ON l.id = r.location_id
     WHERE r.id = $1::uuid AND r.device_type = 'reader'`,
    [parsed.data.readerId, parsed.data.antennaNumber],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Reader not found" }, { status: 404 });
  }
  const row = r.rows[0]!;
  if (row.tenant_id !== session.tid) {
    return NextResponse.json({ error: "Reader belongs to another tenant" }, { status: 403 });
  }

  const flags: AntennaTestFlags = {
    powerArg: Math.round(parsed.data.powerDbm * 10),
    readTimeMs: parsed.data.readTimeMs,
    cycleMode: parsed.data.cycleMode,
    tagFocus: parsed.data.tagFocus,
  };

  const result = createSession({
    tenantId: session.tid,
    locationId: row.location_id,
    readerId: row.reader_id,
    // When antenna row is missing we still need a UUID-shaped placeholder
    // (the session type requires non-null). rawMode prevents any write.
    antennaId: row.antenna_id ?? "00000000-0000-0000-0000-000000000000",
    antennaNumber: parsed.data.antennaNumber,
    flags,
    sweep: null,
    startedBy: (session as { uid?: string }).uid ?? null,
    rawMode: true,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          "Reader is busy. Stop the current test or scan-session, or use the admin Hard Reset on Hardware Config.",
        existingSessionId: result.existing.id,
      },
      { status: 409 },
    );
  }

  publishAntennaTestLifecycle(result.session.id, "armed");

  return NextResponse.json(
    {
      sessionId: result.session.id,
      readerId: result.session.readerId,
      antennaNumber: result.session.antennaNumber,
      antennaConfigured: row.antenna_id !== null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
