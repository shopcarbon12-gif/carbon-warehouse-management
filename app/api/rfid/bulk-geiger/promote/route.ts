import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { decodeEpc, type EpcConfig } from "@/lib/server/epc-decode";
import { decodeSGTIN96 } from "@/lib/utils/epc";
import { pickRandomUniqueSerial } from "@/lib/server/rfid-serial-allocator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bulk Geiger — "flip to live" / auto-add to inventory.
 *
 * Called automatically while a Bulk Geiger fixed-reader scan is running, for
 * each uploaded EPC that was (a) physically found by a reader, (b) passes the
 * tenant EPC formula, and (c) currently has NO status (no items row) or status
 * 'unknown' (lost-track tag). Those are the only two cases the operator asked
 * to promote to LIVE.
 *
 * Per EPC this resolves to exactly one of:
 *   - inserted  — no items row existed → INSERT as 'in-stock' (LIVE)
 *   - promoted  — items row existed with status 'unknown' → UPDATE to 'in-stock'
 *   - skipped   — row already in a real status, EPC doesn't pass the formula,
 *                 or no catalog SKU to attach a fresh row to
 *
 * The single UPSERT below is the safety boundary: a tag already 'in-stock',
 * 'sold', 'return', etc. is NEVER clobbered — the ON CONFLICT DO UPDATE only
 * fires when items.status = 'unknown'. So even if the client over-sends, this
 * route can only insert-fresh or recover-unknown.
 *
 * Body: { epcs: [24-hex, ...] }  (max 2000)
 * Reply: { ok, inserted, promoted, skipped, results: [{ epc, action, status }] }
 */
const bodySchema = z.object({
  epcs: z.array(z.string()).min(1).max(2000),
});

type Action = "inserted" | "promoted" | "skipped";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!session.lid) {
    return NextResponse.json({ error: "No active location" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  // Tenant EPC formula config — same source the live-scan filter and
  // /api/handheld/epc-lookup use to decide "passes formula".
  const cfgRow = await pool.query<{
    prefix_hex: string;
    prefix_bits: number;
    asset_bits: number;
    serial_bits: number;
    asset_padding_digits: number;
  }>(
    `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
       FROM tenant_epc_config WHERE tenant_id = $1::uuid LIMIT 1`,
    [session.tid],
  );
  if (cfgRow.rowCount === 0) {
    return NextResponse.json({ error: "No tenant_epc_config" }, { status: 412 });
  }
  const cfg: EpcConfig = {
    prefixHex: cfgRow.rows[0]!.prefix_hex,
    prefixBits: cfgRow.rows[0]!.prefix_bits,
    assetBits: cfgRow.rows[0]!.asset_bits,
    serialBits: cfgRow.rows[0]!.serial_bits,
    assetPaddingDigits: cfgRow.rows[0]!.asset_padding_digits,
  };

  // Decode + keep only EPCs that pass the formula (valid + known prefix) and
  // carry a system id we can map to the catalog.
  const valid = new Map<string, string>(); // epc → systemId
  for (const rawEpc of parsed.data.epcs) {
    const epc = rawEpc.trim().toUpperCase();
    const d = decodeEpc(epc, cfg);
    if (d.valid && d.systemId !== null) valid.set(epc, d.systemId.toString());
  }

  // Resolve system id → custom_sku_id once for the whole batch.
  const skuBySystemId = new Map<string, string>();
  const systemIds = Array.from(new Set(valid.values()));
  if (systemIds.length > 0) {
    const r = await pool.query<{ ls_system_id: string; id: string }>(
      `SELECT ls_system_id::text AS ls_system_id, id::text AS id
         FROM custom_skus WHERE ls_system_id::text = ANY($1::text[])`,
      [systemIds],
    );
    for (const row of r.rows) skuBySystemId.set(row.ls_system_id, row.id);
  }

  const results: { epc: string; action: Action; status: string | null }[] = [];
  let inserted = 0;
  let promoted = 0;
  let skipped = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const [epc, systemId] of valid.entries()) {
      const customSkuId = skuBySystemId.get(systemId) ?? null;

      if (!customSkuId) {
        // No catalog SKU to anchor a fresh row. We can still recover a
        // lost-track 'unknown' row that already has its SKU, but never
        // create one out of thin air.
        const upd = await client.query<{ epc: string }>(
          `UPDATE items SET status = 'in-stock', location_id = $2::uuid, last_seen_at = now()
            WHERE epc = $1 AND status = 'unknown'
            RETURNING epc`,
          [epc, session.lid],
        );
        if (upd.rowCount && upd.rowCount > 0) {
          promoted++;
          results.push({ epc, action: "promoted", status: "in-stock" });
        } else {
          skipped++;
          results.push({ epc, action: "skipped", status: null });
        }
        continue;
      }

      // Prefer the EPC-encoded serial (chip already broadcasts it); fall
      // back to a fresh random unique 6-digit when it's out of the Carbon
      // range. Mirrors the bulk-import commit policy. Only consumed when the
      // row is actually inserted; harmless for the conflict-update path.
      const decoded = decodeSGTIN96(epc);
      let serial = decoded?.serialNumber ?? 0;
      if (!(serial >= 100_000 && serial <= 999_999)) {
        serial = await pickRandomUniqueSerial(client, customSkuId);
      }

      // Insert fresh as LIVE, OR recover an 'unknown' row to LIVE. A row in
      // any other status is left untouched (DO UPDATE … WHERE status='unknown').
      const r = await client.query<{ inserted: boolean }>(
        `INSERT INTO items (
           epc, serial_number, custom_sku_id, location_id, status,
           source, created_by_user_id, last_seen_at
         )
         VALUES (
           $1, $2::bigint, $3::uuid, $4::uuid, 'in-stock',
           'bulk-geiger', $5::uuid, now()
         )
         ON CONFLICT (epc) DO UPDATE
           SET status = 'in-stock',
               location_id = EXCLUDED.location_id,
               last_seen_at = now()
           WHERE items.status = 'unknown'
         RETURNING (xmax = 0) AS inserted`,
        [epc, serial, customSkuId, session.lid, session.sub],
      );
      const row = r.rows[0];
      if (!row) {
        // Conflict, but the row was in a real status → DO UPDATE skipped it.
        skipped++;
        results.push({ epc, action: "skipped", status: null });
      } else if (row.inserted) {
        inserted++;
        results.push({ epc, action: "inserted", status: "in-stock" });
      } else {
        promoted++;
        results.push({ epc, action: "promoted", status: "in-stock" });
      }
    }

    if (inserted > 0 || promoted > 0) {
      await client.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
         VALUES ($1::uuid, $2::uuid, 'bulk_geiger_promote', 'items', $3::jsonb)`,
        [
          session.tid,
          session.sub,
          JSON.stringify({ location_id: session.lid, inserted, promoted, skipped }),
        ],
      );
    }

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, inserted, promoted, skipped, results });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[bulk-geiger promote]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Server error" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
