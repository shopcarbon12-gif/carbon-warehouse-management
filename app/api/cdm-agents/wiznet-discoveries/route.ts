import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import {
  ingestWiznetDiscoveries,
  listPendingWiznetDiscoveries,
  wiznetDiscoverySchema,
} from "@/lib/server/wiznet-discoveries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent-authed POST: agent reports the WIZnet bridges it discovered on its
 * LAN sweep. Server matches each MAC against `devices.mac_address`:
 *   - hit + IP changed → auto-update devices.network_address (the "follow
 *     the reader through DHCP shuffles" feature)
 *   - miss            → upsert into cdm_agent_discoveries for admin pickup
 *
 * Bearer-authenticated with the agent's API token (NOT a user session).
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const agent = await authenticateAgentToken(pool, m[1].trim());
  if (!agent) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = wiznetDiscoverySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await ingestWiznetDiscoveries(
      client,
      agent.agentId,
      agent.tenantId,
      parsed.data,
    );
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[cdm-agents/wiznet-discoveries POST]", e);
    return NextResponse.json({ error: "Discovery ingest failed" }, { status: 500 });
  } finally {
    client.release();
  }
}

/** Admin-authed GET: pending (unadopted) WIZnet discoveries for this tenant. */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const rows = await listPendingWiznetDiscoveries(pool, session.tid);
  return NextResponse.json({ ok: true, discoveries: rows });
}
