import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  authenticateAgentToken,
  heartbeatSchema,
  recordAgentHeartbeat,
} from "@/lib/server/cdm-agents";
import { extractPublicIp } from "@/lib/server/request-public-ip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Carbon CDM agent endpoint. Bearer-authenticates with the agent's API token
 * (NOT a user session) and records that the agent is alive + reports its
 * version/status. Called every ~30s by the agent.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });
  }
  const token = m[1].trim();

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const agent = await authenticateAgentToken(pool, token);
  if (!agent) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = heartbeatSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  // Capture the agent's public IP from proxy headers — this is what the
  // dashboard's auto-start logic compares against when an operator signs
  // in. Behind Coolify's Traefik, this is the warehouse's NAT public IP.
  const publicIp = extractPublicIp(req);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await recordAgentHeartbeat(client, agent.agentId, parsed.data, publicIp);
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      restart_requested: result.restart_requested,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[cdm-agents/heartbeat]", e);
    return NextResponse.json({ error: "Heartbeat failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
