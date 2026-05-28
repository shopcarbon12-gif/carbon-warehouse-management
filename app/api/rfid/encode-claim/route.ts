import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { envCompanyPrefix } from "@/lib/server/rfid-commission";
import { generateSGTIN96 } from "@/lib/utils/epc";
import { resolveHandheldDeviceId } from "@/lib/server/devices-lookup";

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
  /**
   * Optional fixed-reader UUID. When provided AND `oldEpc` is also
   * provided, the endpoint queues an encode_jobs row so the carbon-cdm
   * agent will physically rewrite the chip's EPC via `MonsoonReader
   * --target_tag <oldEpc> --write_tag <newEpc>`. The response includes
   * the new job id; the caller (Encode Items page) polls /api/rfid/
   * encode-jobs/[id] for status. Handheld callers don't pass this —
   * they perform the physical write themselves via the C72E SDK and
   * just need the DB rotation.
   */
  readerId: z.string().uuid().optional(),
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
  const readerIdForWrite = parsed.data.readerId;

  // Resolve the encoding handheld so source_device_id is set on the
  // items row. Mobile sends the alias via `x-wms-device-id` (same
  // convention as /api/handheld/epc-queue). null when missing or
  // ambiguous — INSERT then writes NULL, attribution still works at the
  // user level via created_by_user_id.
  const handheldHint = req.headers.get("x-wms-device-id");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const sourceDeviceId = await resolveHandheldDeviceId(client, handheldHint, session.tid);

    // Resolve the SKU + its ls_system_id (the asset field of the EPC).
    //
    // Note: custom_skus has NO tenant_id column on this deployment — tenant
    // scope flows through matrices / catalog at higher layers. Filtering
    // here on tenant_id was producing `column "tenant_id" does not exist`
    // (PG 42703) on EVERY encode-claim, which the handheld swallowed as a
    // generic error and surfaced to the operator as "tag issue / write
    // failed." It's how 1891 reads produced 0 written tags. Single-tenant
    // deployment + `customSkuId` is a server-issued UUID that the device
    // received from /api/v1/catalog/items in the immediately preceding
    // step, so the previous catalog lookup IS the tenant scope.
    const sku = await client.query<{ id: string; ls_system_id: string | null }>(
      `SELECT id::text, ls_system_id::text
         FROM custom_skus
         WHERE id = $1::uuid
         LIMIT 1`,
      [customSkuId],
    );
    if (!sku.rows[0]) {
      await client.query("ROLLBACK");
      return NextResponse.json(
        { error: "SKU not found", code: "SKU_NOT_FOUND" },
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

    // Serial selection — serialize concurrent encode-claims for the
    // same (sku, location) so they can't race to the same MAX value.
    // Postgres forbids `FOR UPDATE` on a query containing aggregates
    // (`MAX(serial_number) … FOR UPDATE` errors with "FOR UPDATE is
    // not allowed with aggregate functions"). The original code did
    // exactly that; live evidence 2026-05-26 — every encode attempt
    // came back as "Server error". Switch to a per-(sku, location)
    // advisory transaction lock: cheap, transaction-scoped, releases
    // on COMMIT/ROLLBACK, and lets us read MAX without an extra
    // SELECT … FOR UPDATE.
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('items_serial:' || $1::text || ':' || $2::text, 0)
       )`,
      [customSkuId, session.lid],
    );
    const maxRow = await client.query<{ m: string | null }>(
      `SELECT COALESCE(MAX(serial_number), 0)::text AS m
         FROM items
         WHERE custom_sku_id = $1::uuid AND location_id = $2::uuid`,
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
    //
    // Status: 'unknown' on creation (was 'in-stock' pre-2026-05-28). The
    // handheld Encode screen has just told the chip to broadcast a new
    // EPC — but the WMS has no proof yet that the chip actually committed
    // the write to EEPROM (re-scanning to verify happens AFTER this row
    // is inserted, via the "Test New Tag" screen which routes through
    // ingestEpcs). UNKNOWN is the semantically correct staging state per
    // migration 0080: "we lost track but the tag may still exist" — the
    // handheld can recover it back to 'in-stock' on a subsequent
    // successful re-read, and the operator can flip it manually via the
    // post-encode dropdown (LIVE / TAG KILLED / UNKNOWN).
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
      [newEpc, nextSerial, customSkuId, session.lid, session.sub, handheldHint ?? null, sourceDeviceId],
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

    // When the caller wants a physical chip write (Encode Items page),
    // queue an encode_jobs row. The carbon-cdm agent polls /api/cdm-
    // agents/encode-jobs every few seconds, picks up pending rows for
    // its tenant's readers, runs MonsoonReader --target_tag <old>
    // --write_tag <new>, and reports the result via POST /api/cdm-
    // agents/encode-jobs/[id]/result. The UI polls /api/rfid/encode-
    // jobs/[id] for status. The job is OPTIONAL — handheld callers
    // (Carbon WMS mobile encode screen) perform the write themselves
    // via the C72E SDK and don't pass `readerId`, so no row is queued.
    let jobId: string | null = null;
    if (readerIdForWrite && oldEpc) {
      const job = await client.query<{ id: string }>(
        `INSERT INTO encode_jobs (
           tenant_id, reader_id, requested_by,
           old_epc, new_epc, custom_sku_id, status
         )
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, 'pending')
         RETURNING id::text`,
        [session.tid, readerIdForWrite, session.sub, oldEpc, newEpc, customSkuId],
      );
      jobId = job.rows[0]?.id ?? null;
    }

    await client.query("COMMIT");
    return NextResponse.json({
      ok: true,
      epc: newEpc,
      serial: nextSerial,
      system_id: lsId,
      jobId,
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
