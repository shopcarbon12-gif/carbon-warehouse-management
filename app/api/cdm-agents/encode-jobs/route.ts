import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent-auth: pull pending encode-jobs for the agent's tenant, marking
 * them 'running' in the same transaction so a second poller can't
 * claim the same row. The agent then drives MonsoonReader --target_tag
 * <old> --write_tag <new> against the indicated reader and reports
 * back via POST /api/cdm-agents/encode-jobs/[id]/result.
 *
 * Returns at most `limit` rows (default 5) so a backlogged tenant
 * doesn't block another agent's poll and the per-tick work is
 * bounded.
 *
 * Auth: Bearer agent token (same pattern as /heartbeat).
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

  const agent = await authenticateAgentToken(pool, m[1].trim());
  if (!agent) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const limit = Math.min(
    Math.max(Number(searchParams.get("limit") ?? "5"), 1),
    20,
  );

  // CTE-style claim: pull pending rows for the agent's tenant, lock
  // them with `FOR UPDATE SKIP LOCKED` so concurrent pollers race
  // safely, flip status='running' + started_at + bump attempts, and
  // return the rows the agent should now work. The reader is restricted
  // to readers wired to THIS agent (devices.cdm_agent_id = agent.id)
  // so a misrouted job can never run on someone else's reader.
  const r = await pool.query<{
    id: string;
    reader_id: string;
    reader_network_address: string | null;
    reader_monsoon_serial_port: number;
    old_epc: string;
    new_epc: string;
    custom_sku_id: string;
    attempts: number;
  }>(
    `WITH claimed AS (
       SELECT ej.id
         FROM encode_jobs ej
         INNER JOIN devices d ON d.id = ej.reader_id
        WHERE ej.tenant_id = $1::uuid
          AND ej.status = 'pending'
          AND d.cdm_agent_id = $2::uuid
        ORDER BY ej.created_at ASC
        LIMIT $3::int
        FOR UPDATE OF ej SKIP LOCKED
     )
     UPDATE encode_jobs ej
        SET status = 'running',
            started_at = now(),
            attempts = ej.attempts + 1
       FROM claimed c
       INNER JOIN devices d ON d.id = (
         SELECT reader_id FROM encode_jobs WHERE id = c.id
       )
      WHERE ej.id = c.id
      RETURNING
        ej.id::text                                  AS id,
        ej.reader_id::text                           AS reader_id,
        d.network_address                            AS reader_network_address,
        COALESCE(
          (d.config->>'monsoon_serial_port')::int,
          10002
        )                                            AS reader_monsoon_serial_port,
        ej.old_epc                                   AS old_epc,
        ej.new_epc                                   AS new_epc,
        ej.custom_sku_id::text                       AS custom_sku_id,
        ej.attempts                                  AS attempts`,
    [agent.tenantId, agent.agentId, limit],
  );

  return NextResponse.json(
    { ok: true, jobs: r.rows },
    { headers: { "Cache-Control": "no-store" } },
  );
}
