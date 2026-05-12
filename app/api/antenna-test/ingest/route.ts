import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";
import {
  getSession,
  recordSessionReads,
  touchSession,
} from "@/lib/server/antenna-test-sessions";
import {
  publishAntennaTestRead,
  publishAntennaTestStats,
  publishAntennaTestSweepProgress,
} from "@/lib/server/antenna-test-hub";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent posts a small batch of reads here every ~100 ms while a test
 * session is active. We do NOT write to cdm_reads — these are diagnostic
 * reads, not inventory. Just fan out via the in-process hub so the
 * subscribed browser sees them in near-real-time.
 *
 * Bearer-authenticated by the agent's API token. Listed in proxy.ts
 * allowlist so the proxy passes the request through to this handler.
 */

const readSchema = z.object({
  epcHex: z.string().regex(/^[0-9A-Fa-f]+$/),
  rssiDbm: z.number(),
  antennaNumber: z.coerce.number().int().min(1).max(32),
  observedAt: z.string().datetime().optional(),
  /** Power level for sweep-mode rows; agent stamps when sweeping. */
  powerArg: z.coerce.number().int().min(100).max(330).optional(),
});

const bodySchema = z.object({
  sessionId: z.string().uuid(),
  /** Stats so the page can show "X unique / Y reads/s" without computing
   *  per-tag in the browser. */
  stats: z
    .object({
      uniqueEpcs: z.coerce.number().int().min(0),
      totalReads: z.coerce.number().int().min(0),
      droppedBadCrc: z.coerce.number().int().min(0).default(0),
    })
    .optional(),
  reads: z.array(readSchema).max(500),
  /** Sweep-mode progress, if applicable; agent advances these each step. */
  sweepProgress: z
    .object({
      currentPowerArg: z.coerce.number().int().min(100).max(330),
      stepIndex: z.coerce.number().int().min(0),
      totalSteps: z.coerce.number().int().min(1),
      stepEndsAtMs: z.coerce.number().int().min(0),
    })
    .optional(),
});

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const a = await authenticateAgentToken(pool, m[1].trim());
  if (!a) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

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

  const s = getSession(parsed.data.sessionId);
  if (!s) {
    // Session vanished — agent will see empty active-sessions on next poll
    // and stop posting. Reply 204 so the agent doesn't retry the batch.
    return new NextResponse(null, { status: 204 });
  }
  if (s.locationId !== a.locationId) {
    return NextResponse.json({ error: "Session belongs to another location" }, { status: 403 });
  }

  // Mark the session alive so it doesn't auto-expire while reads are flowing.
  touchSession(s.id);

  // Bump the antenna's last_read_at on every batch with reads. Hardware
  // Config derives the antenna online dot from this timestamp + a 60s
  // freshness window, so a running test makes the dot turn green within
  // ~60s and stay green while reads keep flowing. Operator running a test
  // and seeing reads on screen but a stale offline pill is the bug this
  // patches — pre-fix, only normal-scan reads bumped the timestamp.
  //
  // rawMode (admin reader-raw-test page) suppresses this write so a pure
  // diagnostic run leaves no trace and no green-dot lie on the dashboard.
  if (parsed.data.reads.length > 0) {
    if (!s.rawMode) {
      await pool.query(
        `UPDATE devices SET last_read_at = now(), updated_at = now() WHERE id = $1::uuid`,
        [s.antennaId],
      );
    }
    // Track lifetime reads on the session so /stop can decide pass/fail.
    recordSessionReads(s.id, parsed.data.reads.length);
  }

  for (const r of parsed.data.reads) {
    publishAntennaTestRead(s.id, {
      epcHex: r.epcHex.toUpperCase(),
      rssiDbm: r.rssiDbm,
      antennaNumber: r.antennaNumber,
      observedAt: r.observedAt ?? new Date().toISOString(),
      powerArg: r.powerArg,
    });
  }
  if (parsed.data.stats) publishAntennaTestStats(s.id, parsed.data.stats);
  if (parsed.data.sweepProgress)
    publishAntennaTestSweepProgress(s.id, parsed.data.sweepProgress);

  return NextResponse.json({ ok: true });
}
