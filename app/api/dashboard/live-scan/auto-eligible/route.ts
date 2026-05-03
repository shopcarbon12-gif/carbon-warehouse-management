import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { findAgentByPublicIp } from "@/lib/server/cdm-agents";
import { extractPublicIp } from "@/lib/server/request-public-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dashboard, on mount, calls this. If `eligible: true`, the dashboard
 * automatically POSTs /api/dashboard/live-scan/start so readers spin up
 * without a manual click. If `eligible: false`, the tile stays IDLE and
 * the operator clicks manually (off-network logins, e.g. from home).
 *
 * Eligibility rule: the request's public IP matches an agent's
 * last_known_public_ip AND the agent in question belongs to the
 * operator's tenant.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const ip = extractPublicIp(req);
  if (!ip) {
    return NextResponse.json({ ok: true, eligible: false, reason: "no_ip" });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  const match = await findAgentByPublicIp(pool, ip);
  if (!match) {
    return NextResponse.json({ ok: true, eligible: false, reason: "ip_no_match" });
  }
  if (match.tenantId !== session.tid) {
    return NextResponse.json({ ok: true, eligible: false, reason: "tenant_mismatch" });
  }
  return NextResponse.json({ ok: true, eligible: true, ip });
}
