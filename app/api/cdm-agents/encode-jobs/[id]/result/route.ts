import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent-auth: report the result of a single encode_jobs row. Closes the
 * row out by flipping status to 'done' (write succeeded) or 'failed'
 * (write didn't happen, with a human-readable error_msg). The UI polls
 * /api/rfid/encode-jobs/[id] to surface the new status next render.
 */
const bodySchema = z.object({
  status: z.enum(["done", "failed"]),
  error_msg: z.string().max(2000).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
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

  const { id } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  // Only update if the row belongs to THIS agent's tenant AND a reader
  // owned by THIS agent — defense-in-depth against a captured token
  // being used to close someone else's job.
  const u = await pool.query<{ id: string }>(
    `UPDATE encode_jobs ej
        SET status      = $3,
            error_msg   = $4,
            result_meta = COALESCE($5::jsonb, '{}'::jsonb),
            finished_at = now()
       FROM devices d
      WHERE ej.id = $1::uuid
        AND ej.tenant_id = $2::uuid
        AND d.id = ej.reader_id
        AND d.cdm_agent_id = $6::uuid
        AND ej.status = 'running'
      RETURNING ej.id::text`,
    [
      id,
      agent.tenantId,
      parsed.data.status,
      parsed.data.error_msg ?? null,
      JSON.stringify(parsed.data.meta ?? {}),
      agent.agentId,
    ],
  );
  if (u.rowCount === 0) {
    return NextResponse.json(
      { error: "Job not found, not running, or not owned by this agent" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
