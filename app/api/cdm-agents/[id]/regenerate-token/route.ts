import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { regenerateAgentToken } from "@/lib/server/cdm-agents";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Rotate a Carbon CDM agent's API token. The new token is returned ONCE.
 * Save it immediately — we only store its hash. The old token stops working
 * the moment this responds.
 */
export async function POST(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await params;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { token } = await regenerateAgentToken(client, session.tid, id);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, token });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Token regeneration failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[cdm-agents regenerate-token]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
