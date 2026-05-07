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
 * Carbon CDM agent endpoint. Marks a reader's `status_online` true the
 * moment the agent's supervisor establishes a stable byte stream from the
 * reader's bridge — independent of whether tags are currently flowing.
 *
 * Why a separate endpoint: previously the only signal that flipped
 * `status_online` was the reads-ingest path. A reader that was fully
 * reachable but had no tags in coverage (or no antennas connected) never
 * triggered a read, so the dashboard showed it offline. That conflated
 * "chassis reachable" with "chassis producing tags." The reads-ingest
 * still flips antennas individually online when tags actually arrive on
 * them — only the reader-level bit is decoupled here.
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
        SET status_online = true,
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
