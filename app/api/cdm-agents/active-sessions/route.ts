import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";
import { listActiveSessionsForLocation } from "@/lib/server/antenna-test-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent fast-poll for active antenna-test sessions at its location.
 * Bearer-authenticated by the agent's API token. Returns only sessions for
 * the agent's own location (by joining via cdm_agents row).
 *
 * Response: { sessions: [{ id, readerId, antennaId, antennaNumber, flags,
 *   startedAt }, ...] }
 *
 * Empty array = no test active anywhere; agent reverts everything to
 * normal scan.
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
    startedAt: new Date(s.startedAt).toISOString(),
  }));

  return NextResponse.json({ sessions }, { headers: { "Cache-Control": "no-store" } });
}
