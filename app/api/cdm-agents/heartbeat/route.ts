import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import {
  authenticateAgentToken,
  heartbeatSchema,
  recordAgentHeartbeat,
} from "@/lib/server/cdm-agents";

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

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await recordAgentHeartbeat(client, agent.agentId, parsed.data);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
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
