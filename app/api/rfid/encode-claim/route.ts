import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { envCompanyPrefix } from "@/lib/server/rfid-commission";
import { generateSGTIN96 } from "@/lib/utils/epc";

/**
 * Atomic "claim next serial + insert items row + return the new EPC".
 *
 * Used by the handheld Encode screen (Carbon WMS 1.2.x). One transaction,
 * one round trip. Mirrors the printer-side commission flow but for qty=1
 * with explicit old-EPC kill semantics so the operator can rewrite a tag
 * in one trigger pull.
 *
 * Serial allocation — Scheme C ("hybrid"):
 *   • Per-(custom_sku, location) MAX(serial)+1.
 *   • Floor at 100,001 for SKUs the WMS has never tagged before, so freshly
 *     handheld-encoded tags don't visually stand out next to Senitron's
 *     6-digit serial pool. Once the floor is crossed (max ≥ 100,001) it
 *     keeps incrementing normally.
 *
 * Auth: session OR edge-key (handheld). Manager scope or above (matches
 * /api/inventory/bulk-status).
 *
 * Body:
 *   { customSkuId: uuid, oldEpc?: 24-hex }
 * Response 200:
 *   { ok: true, epc: 24-hex, serial: number, system_id: number }
 * Response 4xx/5xx:
 *   { error: string, code?: string }
 */
export const dynamic = "force-dynamic";

const SERIAL_FLOOR_FOR_FRESH_SKU = 100_000; // next will be >= 100_001

const bodySchema = z.object({
  customSkuId: z.string().uuid(),
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
  const { customSkuId } = parsed.data;
  const oldEpc = parsed.data.oldEpc?.toUpperCase();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Resolve the SKU + its ls_system_id (the asset field of the EPC) and
    // make sure it actually belongs to this tenant.
    const sku = await client.query<{ id: string; ls_system_id: string | null }>(
      `SELECT id::text, ls_system_id::text
         FROM custom_skus
         WHERE id = $1::uuid AND tenant_id = $2::uuid
         LIMIT 1`,
      [customSkuId, session.tid],
    );
    if (!sku.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "SKU not found in this tenant", code: "SKU_NOT_FOUND" },
        { status: 404 },
      );
    }
    const lsRaw = sku.rows[0].ls_system_id;
    const lsId = lsRaw == null ? NaN : Number.parseInt(lsRaw, 10);
    if (!Number.isFinite(lsId) || lsId <= 0) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "SKU has no Lightspeed system_id", code: "NO_SYSTEM_ID" },
        { status: 422 },
      );
    }

    // Serial selection. SELECT … FOR UPDATE on the SKU's existing items at
    // this location locks the per-SKU serial range so two concurrent
    // encode-claim calls can't race to the same MAX value.
    const maxRow = await client.query<{ m: string | null }>(
      `SELECT COALESCE(MAX(serial_number), 0)::text AS m
         FROM items
         WHERE custom_sku_id = $1::uuid AND location_id = $2::uuid
         FOR UPDATE`,
      [customSkuId, session.lid],
    );
    const currentMax = Number(maxRow.rows[0]?.m ?? 0);
    const baseline =
      currentMax > SERIAL_FLOOR_FOR_FRESH_SKU ? currentMax : SERIAL_FLOOR_FOR_FRESH_SKU;
    const nextSerial = baseline + 1;

    // Build the new EPC. Uses the tenant prefix (env override or 985611).
    const cp = envCompanyPrefix();
    const newEpc = generateSGTIN96(cp, lsId, nextSerial).toUpperCase();

    // Insert the new items row. ON CONFLICT (epc) is a defensive guard —
    // the FOR UPDATE lock above already prevents same-tenant collisions.
    const ins = await client.query<{ id: string }>(
      `INSERT INTO items (epc, serial_number, custom_sku_id, location_id, status)
         VALUES ($1, $2::bigint, $3::uuid, $4::uuid, 'in-stock')
         ON CONFLICT (epc) DO NOTHING
         RETURNING id::text`,
      [newEpc, nextSerial, customSkuId, session.lid],
    );
    if (!ins.rows[0]) {
      // Extreme edge case: a Senitron-issued tag with this exact EPC was
      // already imported. Roll back; the caller can retry (next serial
      // will be MAX+1 again, advancing past the conflict on the next try).
      await client.query("ROLLBACK");
      return NextResponse.json(
        {
          error: "EPC collision — retry",
          code: "EPC_COLLISION",
          epc: newEpc,
        },
        { status: 409 },
      );
    }

    // Optional old-EPC kill: when the operator re-encodes a tag that was
    // already known to Carbon WMS, mark the old row killed so it stops
    // counting in inventory. Foreign-prefix tags won't have a row and
    // this UPDATE no-ops cleanly.
    if (oldEpc && oldEpc !== newEpc) {
      await client.query(
        `UPDATE items SET status = 'tag_killed'
           WHERE epc = $1
             AND location_id = $2::uuid
             AND status NOT IN ('tag_killed', 'sold')`,
        [oldEpc, session.lid],
      );
    }

    // Encode-specific audit row in the existing encode_events table
    // (migration 022). Same table the Re-Encode screen writes to via
    // /api/v1/rfid/encode-events, so the two flows share one history.
    await client.query(
      `INSERT INTO encode_events (
         old_epc, new_epc, system_id, serial,
         warehouse_id, device_id, status, encoded_at
       )
       VALUES ($1, $2, $3::bigint, $4::bigint, $5, NULL, 'ok', now())`,
      [oldEpc ?? null, newEpc, lsId, nextSerial, session.lid],
    );

    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      epc: newEpc,
      serial: nextSerial,
      system_id: lsId,
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[rfid/encode-claim]", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  } finally {
    client.release();
  }
}
