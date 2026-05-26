import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Bulk-Import commit: INSERT the operator-selected EPCs into `items` at
 * this location with status='in-stock' (LIVE). Per-EPC serial is the
 * next per-(custom_sku, location) MAX+1, with the same 100_001 floor
 * the handheld encode-claim uses (so freshly bulk-imported tags don't
 * sit next to Senitron's 6-digit pool).
 *
 * After commit the EPCs are in `items` for this location — the bulk-
 * import scan endpoint will filter them out on subsequent scans, so
 * the operator can't accidentally double-import the same tag.
 *
 * Body: { items: [{ epc: 24-hex, custom_sku_id: uuid }, ...] }
 *
 * Idempotent on the ON CONFLICT (epc) clause — if a row already
 * existed (race with parallel encode-claim, etc.), we no-op that row
 * and count it as `skipped` in the response.
 */
const itemSchema = z.object({
  epc: z.string().regex(/^[0-9A-Fa-f]{24}$/u),
  custom_sku_id: z.string().uuid(),
});

const bodySchema = z.object({
  items: z.array(itemSchema).min(1).max(2000),
});

const SERIAL_FLOOR_FOR_FRESH_SKU = 100_000; // next will be >= 100_001

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

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

  // Group by custom_sku_id so we can claim a contiguous serial block
  // per SKU with one SELECT MAX … FOR UPDATE per group.
  const bySku = new Map<string, string[]>();
  for (const it of parsed.data.items) {
    const epc = it.epc.toUpperCase();
    const arr = bySku.get(it.custom_sku_id) ?? [];
    arr.push(epc);
    bySku.set(it.custom_sku_id, arr);
  }

  const client = await pool.connect();
  let inserted = 0;
  let skipped = 0;
  try {
    await client.query("BEGIN");
    for (const [customSkuId, epcs] of bySku.entries()) {
      // Per-(sku, location) advisory lock to serialize concurrent
      // commits. Postgres forbids `FOR UPDATE` on an aggregate, so
      // we serialize via pg_advisory_xact_lock (txn-scoped) instead.
      // See encode-claim for the full rationale.
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
      let nextSerial =
        currentMax > SERIAL_FLOOR_FOR_FRESH_SKU
          ? currentMax + 1
          : SERIAL_FLOOR_FOR_FRESH_SKU + 1;

      for (const epc of epcs) {
        const r = await client.query<{ id: string }>(
          `INSERT INTO items (
             epc, serial_number, custom_sku_id, location_id, status,
             source, created_by_user_id
           )
           VALUES (
             $1, $2::bigint, $3::uuid, $4::uuid, 'in-stock',
             'bulk-import', $5::uuid
           )
           ON CONFLICT (epc) DO NOTHING
           RETURNING id::text`,
          [epc, nextSerial, customSkuId, session.lid, session.sub],
        );
        if (r.rows[0]) {
          inserted++;
          nextSerial++;
        } else {
          // Race: someone else inserted this EPC between our scan and
          // commit. Skip silently — the row exists, the operator's
          // intent is satisfied.
          skipped++;
        }
      }
    }

    // One audit row for the whole bulk operation. Mirrors the
    // cycle-count commit pattern so admins can trace who imported
    // which EPCs into a location and when.
    await client.query(
      `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
       VALUES ($1::uuid, $2::uuid, 'bulk_import_commit', 'items', $3::jsonb)`,
      [
        session.tid,
        session.sub,
        JSON.stringify({
          location_id: session.lid,
          inserted,
          skipped,
          sku_count: bySku.size,
        }),
      ],
    );

    await client.query("COMMIT");
    return NextResponse.json({ ok: true, inserted, skipped });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[bulk-import commit]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Server error" },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
