import { withActivity } from "@/lib/server/activity-log";
/**
 * Locate 2.0 session log (stages C/F): the handheld posts one row when a
 * Locate screen closes — engine, mode, timings (ms from start), outcome and how
 * the item was confirmed. Used to compare engines and gate the rollout.
 * Idempotent on the client-generated id.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

const ms = z.number().int().min(0).max(86_400_000).nullable().optional();
const bodySchema = z.object({
  id: z.string().uuid(),
  deviceId: z.string().max(200).nullable().optional(),
  appVersion: z.string().max(40).nullable().optional(),
  readerModel: z.string().max(120).nullable().optional(),
  readerFirmware: z.string().max(120).nullable().optional(),
  engine: z.string().max(40),
  mode: z.string().max(40),
  targetEpc: z.string().max(64).nullable().optional(),
  targetSku: z.string().max(80).nullable().optional(),
  candidateCount: z.number().int().min(0).max(100000).nullable().optional(),
  startedAt: z.string().datetime(),
  readyMs: ms,
  firstSeenMs: ms,
  confirmedMs: ms,
  endedMs: ms,
  outcome: z.string().max(40).nullable().optional(),
  confirmMethod: z.string().max(60).nullable().optional(),
  confirmedEpc: z.string().max(64).nullable().optional(),
  minPowerDbm: z.number().int().min(0).max(40).nullable().optional(),
  events: z.array(z.record(z.string(), z.unknown())).max(400).optional(),
});

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const b = parsed.data;
  await pool.query(
    `INSERT INTO locate_sessions (id, tenant_id, location_id, user_id, device_id, app_version, reader_model, reader_firmware,
       engine, mode, target_epc, target_sku, candidate_count, started_at, ready_ms, first_seen_ms, confirmed_ms, ended_ms,
       outcome, confirm_method, confirmed_epc, min_power_dbm, events)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::timestamptz, $15, $16, $17, $18,
       $19, $20, $21, $22, $23::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      b.id, session.tid, session.lid, session.sub, b.deviceId ?? null, b.appVersion ?? null, b.readerModel ?? null,
      b.readerFirmware ?? null, b.engine, b.mode, b.targetEpc ?? null, b.targetSku ?? null, b.candidateCount ?? null,
      b.startedAt, b.readyMs ?? null, b.firstSeenMs ?? null, b.confirmedMs ?? null, b.endedMs ?? null, b.outcome ?? null,
      b.confirmMethod ?? null, b.confirmedEpc ?? null, b.minPowerDbm ?? null, JSON.stringify(b.events ?? []),
    ],
  );
  return NextResponse.json({ ok: true });
}

export const POST = withActivity("mobile/locate-sessions", POST_handler);
