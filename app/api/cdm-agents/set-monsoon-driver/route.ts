import { NextResponse } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db";
import { authenticateAgentToken } from "@/lib/server/cdm-agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Diagnostic admin endpoint — flips `devices.config.monsoon_driver` for a
 * reader owned by THIS agent's location. Used during the Phase 0 pilot of
 * `new_monsoonreader --console` to enable/disable the new driver per-reader
 * without a full Hardware Config UI extension. Bearer-authenticated by the
 * agent's API token (NOT a user session). Removable once the Hardware Config
 * UI exposes the same field.
 *
 * Body:  { readerId: uuid, driver: "stream" | "console" }
 * Reply: { ok: true, readerId, driver }
 */

const bodySchema = z.object({
  readerId: z.string().uuid(),
  driver: z.enum(["stream", "console"]),
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

  // Defence in depth — only allow flipping a reader the calling agent
  // actually owns.
  const owns = await pool.query<{ id: string }>(
    `SELECT id::text FROM devices
       WHERE id = $1::uuid AND cdm_agent_id = $2::uuid
         AND device_type IN ('fixed_reader','transaction_reader','door_reader')`,
    [parsed.data.readerId, a.agentId],
  );
  if (owns.rowCount === 0) {
    return NextResponse.json({ error: "Reader not owned by this agent" }, { status: 404 });
  }

  // jsonb_set creates the key if missing; safe vs concurrent writes to other
  // config fields because each set is a single statement.
  await pool.query(
    `UPDATE devices
       SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{monsoon_driver}', to_jsonb($1::text), true),
           updated_at = now()
       WHERE id = $2::uuid`,
    [parsed.data.driver, parsed.data.readerId],
  );

  return NextResponse.json({
    ok: true,
    readerId: parsed.data.readerId,
    driver: parsed.data.driver,
  });
}
