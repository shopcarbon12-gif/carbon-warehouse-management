import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import {
  listCdmAgentsForTenant,
  upsertCdmAgent,
  upsertCdmAgentSchema,
} from "@/lib/server/cdm-agents";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  try {
    const agents = await listCdmAgentsForTenant(pool, session.tid);
    return NextResponse.json({ agents }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[cdm-agents GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

/**
 * Creating a NEW agent returns the freshly-generated `token` ONCE in the response.
 * Save it immediately — it is not retrievable later (only its hash is stored).
 * Updating an existing agent (id provided) does NOT return a token.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = upsertCdmAgentSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id, token } = await upsertCdmAgent(client, session.tid, parsed.data);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id, ...(token ? { token } : {}) });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Save failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[cdm-agents POST]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
