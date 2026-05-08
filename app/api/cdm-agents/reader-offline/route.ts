import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  readerId: z.string().uuid(),
});

/**
 * Carbon CDM agent endpoint. Marks a reader's `status_online` false when
 * the agent's silence watchdog detects the chip has stopped emitting bytes
 * (>=60 s of zero bytes from the chassis). Until this endpoint existed,
 * status_online was a sticky boolean — once true, nothing ever flipped it
 * back — so a reader that lost network or had its chip die kept showing
 * online forever in Hardware Config.
 *
 * Antennas are intentionally NOT touched here: the antenna-level status
 * stays sticky-true off its last successful read, on the reasoning that a
 * dead reader implies dead antennas anyway, and operators want the visual
 * cue ("antenna 1 ever produced reads") preserved.
 *
 * Idempotent — the agent-side throttle (~once per minute) re-pushes
 * periodically so a server-side row stuck at status_online=true after a
 * prior agent crash self-heals on the next watchdog tick.
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

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const result = await pool.query(
    `UPDATE devices
        SET status_online = false,
            updated_at = now()
      WHERE id = $1::uuid
        AND tenant_id = $2::uuid
        AND cdm_agent_id = $3::uuid
        AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [parsed.data.readerId, agent.tenantId, agent.agentId],
  );
  if (result.rowCount === 0) {
    return NextResponse.json(
      { error: "Reader not found or not owned by this agent" },
      { status: 400 },
    );
  }
  return NextResponse.json({ ok: true });
}
