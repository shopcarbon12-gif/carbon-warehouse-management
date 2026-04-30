import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Agent reports the outcome of an antenna connection test.
 *
 * Body:
 *   {
 *     antennaId,
 *     foundAnyEpc,        ← true if any EPC bytes seen during the listen window
 *     observedEpcCount,   ← total tag-reads counted (any prefix)
 *     testStartedAt,      ← when the agent opened the listen window (ISO)
 *     testEndedAt,        ← when the listen window closed (ISO)
 *   }
 *
 * Side effects:
 *   - devices.status_online    = foundAnyEpc
 *   - devices.last_test_at     = testEndedAt
 *   - devices.last_test_passed = foundAnyEpc
 *   - devices.last_test_epc_count = observedEpcCount
 *   - devices.test_pending_at  = NULL  (test consumed)
 *
 * Bearer-authenticated via the agent's API token. Antenna must belong to a
 * reader owned by the same agent (prevents cross-agent state changes).
 */

const bodySchema = z.object({
  antennaId: z.string().uuid(),
  foundAnyEpc: z.boolean(),
  observedEpcCount: z.coerce.number().int().min(0).max(1_000_000).default(0),
  testStartedAt: z.string().datetime(),
  testEndedAt: z.string().datetime(),
});

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return NextResponse.json({ error: "Missing Bearer token" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const a = await authenticateAgentToken(pool, m[1].trim());
  if (!a) return NextResponse.json({ error: "Invalid token" }, { status: 401 });

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

  // Verify the antenna belongs to a reader owned by THIS agent (defence in
  // depth — wouldn't be exploitable by a non-agent caller anyway since we
  // checked the bearer above, but blocks cross-agent confusion).
  const owns = await pool.query<{ id: string }>(
    `SELECT a.id::text
       FROM devices a
       INNER JOIN devices reader ON reader.id = a.parent_device_id
       INNER JOIN locations l ON l.id = reader.location_id AND l.tenant_id = $1::uuid
      WHERE a.id = $2::uuid AND a.device_type = 'antenna'
        AND reader.cdm_agent_id = $3::uuid`,
    [a.tenantId, parsed.data.antennaId, a.agentId],
  );
  if (owns.rowCount === 0) {
    return NextResponse.json({ error: "Antenna not owned by this agent" }, { status: 404 });
  }

  await pool.query(
    `UPDATE devices SET
       status_online        = $1::boolean,
       last_test_at         = $2::timestamptz,
       last_test_passed     = $1::boolean,
       last_test_epc_count  = $3::int,
       test_pending_at      = NULL,
       updated_at           = now()
       WHERE id = $4::uuid`,
    [
      parsed.data.foundAnyEpc,
      parsed.data.testEndedAt,
      parsed.data.observedEpcCount,
      parsed.data.antennaId,
    ],
  );

  return NextResponse.json({ ok: true });
}
