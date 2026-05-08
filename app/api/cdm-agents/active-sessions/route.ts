import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";
import { listActiveSessionsForLocation } from "@/lib/server/antenna-test-sessions";
import { listActiveSessionsForLocation as listScanSessionsForLocation } from "@/lib/server/scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent fast-poll for active sessions at its location.
 * Bearer-authenticated by the agent's API token. Returns only sessions for
 * the agent's own location (by joining via cdm_agents row).
 *
 * Two session families:
 *   - sessions     — antenna-test sessions (TEST_MODE: preempts the reader,
 *                    reads go to /api/antenna-test/ingest, no DB writes)
 *   - scanSessions — workflow wakes from Transfer Out / Cycle Counts /
 *                    Print-Commission. Supervisor treats the reader as
 *                    un-paused while a session is active, overriding any
 *                    persisted scan_paused_at. Reads flow through the normal
 *                    /api/cdm-agents/reads pipeline.
 *
 * Empty arrays = no workflow active; supervisor reverts to baseline (which
 * is "paused" by default in the new model).
 */

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const a = await authenticateAgentToken(pool, m[1].trim());
  if (!a) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

  const sessions = listActiveSessionsForLocation(a.locationId).map((s) => ({
    id: s.id,
    readerId: s.readerId,
    antennaId: s.antennaId,
    antennaNumber: s.antennaNumber,
    flags: s.flags,
    sweep: s.sweep,
    startedAt: new Date(s.startedAt).toISOString(),
  }));

  const scanSessions = listScanSessionsForLocation(a.locationId).map((s) => ({
    id: s.id,
    readerId: s.readerId,
    kind: s.kind,
    startedAt: new Date(s.startedAt).toISOString(),
  }));

  return NextResponse.json(
    { sessions, scanSessions },
    { headers: { "Cache-Control": "no-store" } },
  );
}
