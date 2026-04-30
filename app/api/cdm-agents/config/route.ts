import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  authenticateAgentToken,
  getAgentConfigBundle,
} from "@/lib/server/cdm-agents";
import { ensureAntennaTestSchema } from "@/lib/server/ensure-antenna-test-schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carbon CDM agent endpoint. The agent calls this on startup and on every
 * config-poll tick to learn which readers/antennas it should manage.
 * Bearer-authenticates with the agent's API token (NOT a user session).
 */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  // Guard: getAgentConfigBundle SELECTs devices.test_pending_at; if the column
  // is missing the agent's startup poll throws and the agent disconnects,
  // which is what's been blocking ALL scans on prod. Self-heal first.
  await ensureAntennaTestSchema(pool);

  const auth_ = await authenticateAgentToken(pool, m[1].trim());
  if (!auth_) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const bundle = await getAgentConfigBundle(pool, auth_.agentId);
  if (!bundle) {
    return NextResponse.json({ error: "Agent record disappeared" }, { status: 404 });
  }
  return NextResponse.json(bundle, { headers: { "Cache-Control": "no-store" } });
}
