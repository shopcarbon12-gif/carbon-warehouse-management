import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import {
  getAgentDiagnosis,
  requestAgentRecover,
} from "@/lib/server/cdm-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Admin-driven recover endpoint. Stamps `cdm_agents.recover_requested_at`
 * so the agent's next heartbeat sees a request newer than its boot_time
 * and exits cleanly. systemd respawns it with fresh state.
 *
 * Returns a diagnosis snapshot taken AT the moment of the click — so the
 * UI can show "before" state alongside the post-restart state from polling.
 *
 * GET on the same path returns the diagnosis snapshot WITHOUT requesting
 * a recover (used to populate the modal before the operator commits).
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await getSessionFromRequest(_req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const diag = await getAgentDiagnosis(pool, session.tid, id);
  if (!diag) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json({ ok: true, diagnosis: diag });
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isAdminRole(session.role))
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const before = await getAgentDiagnosis(pool, session.tid, id);
  if (!before) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stamp = await requestAgentRecover(client, session.tid, id, session.sub);
    await client.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
         VALUES ($1::uuid, $2::uuid, 'cdm_agent_recover_requested', 'cdm_agents', $3::jsonb)`,
      [
        session.tid,
        session.sub,
        JSON.stringify({
          agent_id: id,
          requested_at: stamp.recover_requested_at,
          before_diagnosis: before,
        }),
      ],
    );
    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      recover_requested_at: stamp.recover_requested_at,
      diagnosis: before,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Recover failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[cdm-agents/recover]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
