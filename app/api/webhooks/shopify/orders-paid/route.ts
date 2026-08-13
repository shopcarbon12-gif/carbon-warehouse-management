import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify orders/paid webhook — Shopify sale → WMS qty reconciliation.
 *
 * For each sold line item (by SKU):
 *   • RFID item  → flip the OLDEST N in-stock EPCs to `unknown` (N = quantity).
 *                  Live qty drops immediately so WMS matches Shopify. The tag
 *                  actually shipped is later flipped to `sold` at the ship
 *                  scan-out; the daily cycle count flips any still-present
 *                  `unknown` tag back to `in-stock`. EPC values are never touched.
 *   • Manual item → decrement manual_item_qty by N (never below 0).
 *
 * Public route (no WMS session) — authenticated by Shopify HMAC. Idempotent per
 * order id via shopify_sale_events.
 */
type LineItem = { sku?: string | null; quantity?: number | null; title?: string | null };

export async function POST(req: Request) {
  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhookHmac(raw, hmac)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let order: { id?: number | string; name?: string; line_items?: LineItem[] };
  try {
    order = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const orderId = String(order.id ?? "").trim();
  if (!orderId) return NextResponse.json({ ok: true, skipped: "no order id" });
  const lineItems = Array.isArray(order.line_items) ? order.line_items : [];

  const pool = getPool();
  if (!pool) return NextResponse.json({ ok: false, error: "db" }, { status: 500 });

  // Idempotency: claim the order id. If already processed, ack and stop.
  const claim = await pool.query(
    `INSERT INTO shopify_sale_events (order_id, order_name, line_count)
       VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING RETURNING order_id`,
    [orderId, order.name ?? null, lineItems.length],
  );
  if (claim.rowCount === 0) return NextResponse.json({ ok: true, duplicate: true });

  let flipped = 0;
  let manualDec = 0;
  const detail: Array<Record<string, unknown>> = [];

  for (const li of lineItems) {
    const sku = String(li.sku ?? "").trim();
    const qty = Math.floor(Number(li.quantity) || 0);
    if (!sku || qty <= 0) continue;

    // Resolve the ACTIVE custom_sku (archived rows can share a SKU — never them).
    const cs = await pool.query<{ id: string; manual: boolean }>(
      `SELECT cs.id::text AS id, COALESCE(m.is_manual_only, FALSE) AS manual
         FROM custom_skus cs JOIN matrices m ON m.id = cs.matrix_id
        WHERE cs.sku = $1 AND cs.archived = FALSE
        LIMIT 1`,
      [sku],
    );
    if (cs.rowCount === 0) {
      detail.push({ sku, qty, result: "no wms match" });
      continue;
    }
    const customSkuId = cs.rows[0].id;

    if (cs.rows[0].manual) {
      const r = await pool.query<{ current_qty: number }>(
        `UPDATE manual_item_qty
            SET current_qty = GREATEST(0, current_qty - $2), updated_at = now()
          WHERE custom_sku_id = $1::uuid
          RETURNING current_qty`,
        [customSkuId, qty],
      );
      manualDec += r.rowCount ?? 0;
      detail.push({ sku, qty, kind: "manual", rows: r.rowCount, newQty: r.rows[0]?.current_qty ?? null });
    } else {
      // Flip the OLDEST N in-stock EPCs → unknown.
      const r = await pool.query<{ epc: string }>(
        `UPDATE items SET status = 'unknown', last_seen_at = last_seen_at
          WHERE id IN (
            SELECT id FROM items
             WHERE custom_sku_id = $1::uuid AND status = 'in-stock'
             ORDER BY first_scanned_at ASC NULLS FIRST, serial_number ASC
             LIMIT $2
             FOR UPDATE SKIP LOCKED
          )
          RETURNING epc`,
        [customSkuId, qty],
      );
      flipped += r.rowCount ?? 0;
      detail.push({
        sku,
        qty,
        kind: "rfid",
        flipped: r.rowCount,
        shortfall: qty - (r.rowCount ?? 0), // oversell (fewer in-stock than sold)
        epcs: r.rows.map((x) => x.epc),
      });
    }
  }

  await pool.query(
    `UPDATE shopify_sale_events
        SET flipped_unknown = $2, manual_decremented = $3, detail = $4::jsonb
      WHERE order_id = $1`,
    [orderId, flipped, manualDec, JSON.stringify(detail)],
  );

  return NextResponse.json({ ok: true, flipped, manualDec });
}
