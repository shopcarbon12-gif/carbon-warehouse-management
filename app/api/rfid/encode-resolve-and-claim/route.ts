import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { envCompanyPrefix } from "@/lib/server/rfid-commission";
import { generateSGTIN96 } from "@/lib/utils/epc";
import { resolveHandheldDeviceId } from "@/lib/server/devices-lookup";
import { pickRandomUniqueSerial } from "@/lib/server/rfid-serial-allocator";

/**
 * Single-round-trip catalog lookup + atomic encode-claim.
 *
 * Replaces the two-step pattern the handheld used to do:
 *
 *   GET  /api/v1/catalog/items?custom_sku=...   (round-trip 1)
 *   POST /api/rfid/encode-claim {customSkuId,…} (round-trip 2)
 *
 * On warehouse Wi-Fi each round-trip is ~200-500 ms; the handheld pays
 * both for every re-encoded chip even though all the operator wants is
 * "the next valid newEpc." Merging them halves the network latency per
 * tag.
 *
 * Same trust + side-effects as encode-claim:
 *   - Session JWT only (Manager+).
 *   - Resolves the handheld via `x-wms-device-id` for source_device_id.
 *   - INSERTs the new items row at status='unknown' (the chip write
 *     happens AFTER this; encode-finalize promotes to 'in-stock' once
 *     the handheld confirms).
 *   - Marks the old EPC row 'tag_killed' when supplied + present.
 *   - Random 6-digit serial unique within the custom_sku.
 *
 * Body:
 *   { customSku: string, oldEpc?: 24-hex }
 * Reply 200:
 *   { ok: true, epc: 24-hex, serial: number, system_id: number,
 *     customSkuId, customSku, name }
 * Errors mirror encode-claim's: SKU_NOT_FOUND, NO_SYSTEM_ID,
 *   EPC_COLLISION (retryable), generic 500.
 */
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  customSku: z.string().trim().min(1).max(128),
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
  const customSku = parsed.data.customSku;
  const oldEpc = parsed.data.oldEpc?.toUpperCase();
  const handheldHint = req.headers.get("x-wms-device-id");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceDeviceId = await resolveHandheldDeviceId(client, handheldHint, session.tid);

    // Phase 1 — catalog resolution. Same query the handheld used to make
    // out-of-band via /api/v1/catalog/items, now inside the encode-claim
    // transaction.
    const sku = await client.query<{
      id: string;
      ls_system_id: string | null;
      description: string | null;
      sku: string;
    }>(
      `SELECT cs.id::text,
              cs.ls_system_id::text AS ls_system_id,
              m.description,
              cs.sku
         FROM custom_skus cs
         LEFT JOIN matrices m ON m.id = cs.matrix_id
        WHERE LOWER(cs.sku) = LOWER($1::text)
        LIMIT 1`,
      [customSku],
    );
    const row = sku.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "SKU not found", code: "SKU_NOT_FOUND" },
        { status: 404 },
      );
    }
    const lsRaw = row.ls_system_id;
    const lsId = lsRaw == null ? NaN : Number.parseInt(lsRaw, 10);
    if (!Number.isFinite(lsId) || lsId <= 0) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "SKU has no Lightspeed system_id", code: "NO_SYSTEM_ID" },
        { status: 422 },
      );
    }
    const customSkuId = row.id;

    // Phase 2 — claim. Identical to /api/rfid/encode-claim's body.
    const nextSerial = await pickRandomUniqueSerial(client, customSkuId);
    const cp = envCompanyPrefix();
    const newEpc = generateSGTIN96(cp, lsId, nextSerial).toUpperCase();

    const ins = await client.query<{ id: string }>(
      `INSERT INTO items (
         epc, serial_number, custom_sku_id, location_id, status,
         source, source_device_label, source_device_id, created_by_user_id
       ) VALUES (
         $1, $2::bigint, $3::uuid, $4::uuid, 'unknown',
         'handheld', $6, $7::uuid, $5::uuid
       )
       ON CONFLICT (epc) DO NOTHING
       RETURNING id::text`,
      [
        newEpc,
        nextSerial,
        customSkuId,
        session.lid,
        session.sub,
        handheldHint ?? null,
        sourceDeviceId,
      ],
    );
    if (!ins.rows[0]) {
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

    if (oldEpc && oldEpc !== newEpc) {
      await client.query(
        `UPDATE items SET status = 'tag_killed'
           WHERE epc = $1
             AND location_id = $2::uuid
             AND status NOT IN ('tag_killed', 'sold')`,
        [oldEpc, session.lid],
      );
    }

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
      customSkuId,
      customSku: row.sku,
      name: row.description ?? "",
    });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[rfid/encode-resolve-and-claim]", e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  } finally {
    client.release();
  }
}
