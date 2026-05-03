import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { findAgentByPublicIp } from "@/lib/server/cdm-agents";
import { extractPublicIp } from "@/lib/server/request-public-ip";
import { upsertSession } from "@/lib/server/live-scan-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public endpoint (no auth required) — fires on /login page mount.
 *
 * Reads the request's public IP. If it matches any agent's
 * last_known_public_ip, starts that agent's tenant's live-scan session.
 * The agent's next config-poll (≤1 s) sees live_scan_active: true and
 * spawns the reader binary; by the time the operator finishes signing
 * in (~10 s), the radio is already warmed up and reads are flowing.
 *
 * Idempotent: if a session is already active, refreshes lastSeenAt.
 *
 * Risk: anyone in the warehouse who loads /login triggers reader spin-up
 * without authenticating. Acceptable for the warehouse setting. If
 * nobody actually signs in, the heartbeat-based 60 s session timeout
 * cleans up automatically.
 */
export async function POST(req: Request) {
  const ip = extractPublicIp(req);
  if (!ip) {
    return NextResponse.json({ ok: true, prewarmed: false, reason: "no_ip" });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json(
      { ok: true, prewarmed: false, reason: "db_unavailable" },
      { status: 200 },
    );
  }
  const match = await findAgentByPublicIp(pool, ip);
  if (!match) {
    return NextResponse.json({ ok: true, prewarmed: false, reason: "ip_no_match" });
  }
  const session = upsertSession({ tenantId: match.tenantId, startedBy: null });
  return NextResponse.json({
    ok: true,
    prewarmed: true,
    session_id: session.id,
    started_at: new Date(session.startedAt).toISOString(),
  });
}
