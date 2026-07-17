import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { envCompanyPrefix } from "@/lib/server/rfid-commission";
import { generateSGTIN96 } from "@/lib/utils/epc";
import { resolveHandheldDeviceId } from "@/lib/server/devices-lookup";
import { pickRandomUniqueSerial } from "@/lib/server/rfid-serial-allocator";

/**
 * Atomic "claim next serial + insert items row + return the new EPC".
 *
 * Used by the handheld Encode screen (Carbon WMS 1.2.x). One transaction,
 * one round trip. Mirrors the printer-side commission flow but for qty=1
 * with explicit old-EPC kill semantics so the operator can rewrite a tag
 * in one trigger pull.
 *
 * Serial allocation — Random 6-digit, per-custom_sku unique
 * (Carbon-Jeans policy 2026-05-29):
 *   • Pick a random integer in [100_000, 999_999]; reject draws that
 *     already exist for this custom_sku.
 *   • The sequential MAX+1 scheme is gone: a single stuck row (e.g.
 *     serial=12 from an old import) used to wedge every later write
 *     because the next allocation would collide on EPC. Random draws
 *     are agnostic to existing serial layout and produce truly 6-digit
 *     values from day one.
 *   • The advisory_xact_lock on (sku, location) below is now redundant
 *     for the random path but kept for the EPC INSERT step's safety —
 *     two simultaneous tabs picking the same random serial still get
 *     stopped by the `items.epc` UNIQUE constraint (caller retries on
 *     23505 by re-invoking encode-claim).
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

  // ── Pre-flight: never rotate the DB for a chip-write we can't deliver ───────
  // When the Encode Items page asks for a physical fixed-reader write it passes
  // `readerId`. Historically we rotated the items row (killed old EPC, minted
  // new) and THEN queued the encode_jobs row — but if the chosen reader isn't
  // managed by a live carbon-cdm agent (e.g. the multi-antenna .16, which is
  // unassigned / Senitron-owned), no agent ever claims the job and it fails
  // with `reader_unmanaged_or_in_test` AFTER the DB was already rotated. The
  // operator was left with a rotated row and a still-old chip ("DB rotated,
  // retry from handheld"). Validate manageability up front and bail cleanly —
  // WITHOUT touching the DB — so the tag stays intact and the operator can pick
  // a live reader or use the handheld.
  if (readerIdForWrite && oldEpc) {
    try {
      const chk = await pool.query<{
        name: string | null;
        network_address: string | null;
        cdm_agent_id: string | null;
        agent_status: string | null;
        agent_live: boolean | null;
      }>(
        `SELECT
           d.name,
           d.network_address,
           d.cdm_agent_id::text AS cdm_agent_id,
           a.status            AS agent_status,
           (a.last_heartbeat_at > now() - interval '2 minutes') AS agent_live
         FROM devices d
         LEFT JOIN cdm_agents a ON a.id = d.cdm_agent_id
         WHERE d.id = $1::uuid
         LIMIT 1`,
        [readerIdForWrite],
      );
      const row = chk.rows[0];
      const label = (row?.name || row?.network_address || "This reader").trim();
      if (!row) {
        return NextResponse.json(
          { error: "Reader not found", code: "READER_NOT_FOUND" },
          { status: 404 },
        );
      }
      if (!row.cdm_agent_id) {
        return NextResponse.json(
          {
            error: `${label} isn't assigned to a CDM agent, so it can't program a chip. Encode this tag from the handheld instead.`,
            code: "READER_UNMANAGED",
          },
          { status: 409 },
        );
      }
      if (row.agent_status === "offline" || row.agent_live !== true) {
        return NextResponse.json(
          {
            error: `${label}'s CDM agent is offline — no fixed-reader write is possible right now. Encode this tag from the handheld instead.`,
            code: "READER_AGENT_OFFLINE",
          },
          { status: 409 },
        );
      }
    } catch (e) {
      console.error("[rfid/encode-claim] reader preflight", e);
      return NextResponse.json(
        { error: "Reader check failed — try again." },
        { status: 503 },
      );
    }
  }

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

    // Random 6-digit serial unique within this custom_sku (across all
    // locations — items.epc is globally UNIQUE so two locations writing
    // the same (sku, serial) would collide on INSERT anyway). The
    // advisory lock that used to serialize concurrent claims for the
    // sequential MAX+1 scheme is no longer needed; the constraint
    // catches the rare two-tabs-pick-same-random case and the caller
    // retries.
    const nextSerial = await pickRandomUniqueSerial(client, customSkuId);

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

    // NOTE (2026-06-05): the old EPC is intentionally NOT touched here.
    // Pre-fix this flipped the old row to 'tag_killed' at CLAIM time —
    // before the physical chip write was confirmed. When the write then
    // FAILED (verify false-fail, weak tag, etc.) the old chip was still
    // perfectly live, but its WMS row had already been removed from
    // inventory and was never restored — 100+ live items silently
    // vanished. The old EPC is now retired ONLY by /encode-finalize,
    // and ONLY once the new EPC is confirmed live. A failed write leaves
    // the old row exactly as it was (in-stock), which is correct.

    // Encode-specific audit row in the existing encode_events table
    // (migration 022). Logged as 'pending' — the claim succeeded but the
    // chip write is NOT yet confirmed. /encode-finalize promotes the row
    // to 'ok' on a confirmed write; a failed write leaves it 'pending'
    // (and the device additionally logs a 'write_failed' event), so the
    // Re-Encode report never shows a write as successful when it wasn't.
    await client.query(
      `INSERT INTO encode_events (
         old_epc, new_epc, system_id, serial,
         warehouse_id, device_id, status, encoded_at, created_by
       )
       VALUES ($1, $2, $3::bigint, $4::bigint, $5, NULL, 'pending', now(), $6)`,
      [oldEpc ?? null, newEpc, lsId, nextSerial, session.lid, session.sub],
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
