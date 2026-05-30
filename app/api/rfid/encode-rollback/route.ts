import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

/**
 * Roll back an in-flight encode whose chip write failed.
 *
 * `encode-resolve-and-claim` runs BEFORE the chip is physically written:
 * it allocates a fresh serial and INSERTs the new EPC's items row at
 * `status='unknown'`. If the handheld then reports the chip write
 * failed, that items row is a phantom — no physical chip carries that
 * EPC, but the row sits in catalog at status='unknown', the serial is
 * burned, and any future bulk-flip or sweep query may treat it as real
 * inventory.
 *
 * This route deletes that phantom row outright. Scoped to:
 *   - tenant + active location (from session)
 *   - status='unknown' ONLY — if the row was already promoted by some
 *     other path (operator manually marked it, a reader sighted it, a
 *     finalize call landed after) we leave it alone to avoid clobbering
 *     legitimate state.
 *
 * The OLD EPC's items row is NOT touched. encode-claim marked it
 * 'tag_killed' (idempotent — the re-encode flow targets already-defective
 * chips). The physical chip still carries the old EPC; keeping it as
 * 'tag_killed' matches reality.
 *
 * Always writes an `encode_events` audit row with status='rolled_back'
 * so the per-EPC trail (claim → write_failed → rolled_back) is intact.
 *
 * Body: { newEpc, oldEpc? } (24-hex each)
 * Reply: { ok, deleted: bool }
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  newEpc: z.string().regex(/^[0-9A-Fa-f]{24}$/u, "newEpc must be 24 hex chars"),
  oldEpc: z
    .string()
    .regex(/^[0-9A-Fa-f]{24}$/u, "oldEpc must be 24 hex chars")
    .optional(),
});

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const newEpc = parsed.data.newEpc.toUpperCase();
  const oldEpc = parsed.data.oldEpc?.toUpperCase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const del = await client.query(
      `DELETE FROM items i
        USING locations l
        WHERE i.location_id = l.id
          AND l.tenant_id = $1::uuid
          AND i.location_id = $2::uuid
          AND i.epc = $3
          AND i.status = 'unknown'`,
      [session.tid, session.lid, newEpc],
    );
    const deleted = (del.rowCount ?? 0) > 0;

    await client.query(
      `INSERT INTO encode_events (
         old_epc, new_epc, system_id, serial,
         warehouse_id, device_id, status, encoded_at
       )
       VALUES ($1, $2, NULL, NULL, $3, NULL, 'rolled_back', now())`,
      [oldEpc ?? null, newEpc, session.lid],
    );

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[rfid/encode-rollback]", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  } finally {
    client.release();
  }
}
