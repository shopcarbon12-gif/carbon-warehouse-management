import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  createSession,
  type AntennaTestFlags,
} from "@/lib/server/antenna-test-sessions";
import { publishAntennaTestLifecycle } from "@/lib/server/antenna-test-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start an antenna test session. Cookie-session authenticated; the user
 * must own the antenna (matching tenant) and the antenna must be attached
 * to a reader via parent_device_id. We resolve the reader from the
 * antenna so the operator only has to pick the antenna they care about.
 *
 * Body: {
 *   antennaId: uuid,
 *   flags: { powerArg, readTimeMs, cycleMode, tagFocus }
 * }
 * Returns: { sessionId, readerId, antennaNumber }
 *
 * 409 if another session is already active on the same reader.
 */

const flagsSchema = z.object({
  powerArg: z.coerce.number().int().min(100).max(330),
  readTimeMs: z.coerce.number().int().min(250).max(5000),
  cycleMode: z.enum(["infinite", "oscillating"]),
  tagFocus: z.coerce.boolean(),
});

const sweepSchema = z
  .object({
    startPowerArg: z.coerce.number().int().min(100).max(330),
    endPowerArg: z.coerce.number().int().min(100).max(330),
    stepPowerArg: z.coerce.number().int().min(1).max(50),
    dwellMs: z.coerce.number().int().min(500).max(10_000),
  })
  .refine((s) => s.endPowerArg > s.startPowerArg, {
    message: "endPowerArg must be greater than startPowerArg",
  });

const bodySchema = z.object({
  antennaId: z.string().uuid(),
  flags: flagsSchema,
  sweep: sweepSchema.nullable().optional(),
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

  // Look up antenna + parent reader; verify tenant.
  const r = await pool.query<{
    antenna_id: string;
    antenna_number: number;
    reader_id: string;
    location_id: string;
    tenant_id: string;
    reader_online: boolean;
    reader_quarantine_reason: string | null;
  }>(
    `SELECT
       a.id::text         AS antenna_id,
       (a.config->>'antenna_number')::int AS antenna_number,
       r.id::text         AS reader_id,
       r.location_id::text AS location_id,
       l.tenant_id::text  AS tenant_id,
       r.status_online    AS reader_online,
       r.quarantine_reason AS reader_quarantine_reason
     FROM devices a
     INNER JOIN devices r ON r.id = a.parent_device_id
     INNER JOIN locations l ON l.id = r.location_id
     WHERE a.id = $1::uuid AND a.device_type = 'antenna'`,
    [parsed.data.antennaId],
  );
  if (r.rowCount === 0) {
    return NextResponse.json({ error: "Antenna not found" }, { status: 404 });
  }
  const row = r.rows[0]!;
  if (row.tenant_id !== session.tid) {
    return NextResponse.json({ error: "Antenna belongs to another tenant" }, { status: 403 });
  }
  // Antenna tests on a quarantined reader can never produce reads —
  // chassis hardware is dead. Refuse early so the operator gets a real
  // reason instead of staring at a never-arming test.
  if (row.reader_quarantine_reason) {
    return NextResponse.json(
      {
        error: `Reader is quarantined: ${row.reader_quarantine_reason}`,
        reason: "reader_quarantined",
        quarantine_reason: row.reader_quarantine_reason,
      },
      { status: 409 },
    );
  }

  // When sweep is requested, override the initial flags.powerArg with the
  // sweep's start so the first spawn is at the bottom of the ramp.
  const initialFlags: AntennaTestFlags = parsed.data.sweep
    ? {
        ...(parsed.data.flags as AntennaTestFlags),
        powerArg: parsed.data.sweep.startPowerArg,
      }
    : (parsed.data.flags as AntennaTestFlags);

  const result = createSession({
    tenantId: session.tid,
    locationId: row.location_id,
    readerId: row.reader_id,
    antennaId: row.antenna_id,
    antennaNumber: row.antenna_number ?? 1,
    flags: initialFlags,
    sweep: parsed.data.sweep ?? null,
    startedBy: (session as { uid?: string }).uid ?? null,
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: "Reader is already in test mode",
        existingSessionId: result.existing.id,
        existingReaderId: result.existing.readerId,
      },
      { status: 409 },
    );
  }

  // Browser will subscribe to the SSE channel right after this call returns,
  // so emit the initial "armed" lifecycle event eagerly. The agent's first
  // poll (≤1 s away) will pick up the session and start the spawn — we'll
  // emit "live" from /ingest the first time a read arrives.
  publishAntennaTestLifecycle(result.session.id, "armed");

  return NextResponse.json(
    {
      sessionId: result.session.id,
      readerId: result.session.readerId,
      antennaNumber: result.session.antennaNumber,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
