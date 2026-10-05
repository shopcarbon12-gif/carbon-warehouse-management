import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify orders/fulfilled webhook — the order has shipped.
 *
 * When it was paid, orders-paid marked one LIVE tag per item UNKNOWN as a
 * placeholder (shopify_sale_events.detail). Now that it is fulfilled, every one
 * of those tags that is STILL unknown goes back to LIVE — the owner's rule
 * (2026-10-05). A tag that has since become anything else (sold, damaged, tag
 * killed, …) is left exactly as it is. Each change gets a STATUS_CHANGE audit
 * row. Re-delivery is harmless: a tag already back to LIVE is no longer unknown.
 *
 * Public route (no WMS session) — authenticated by Shopify HMAC.
 */
async function POST_handler(req: Request) {
  const raw = await req.text();
  if (!verifyShopifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  let order: { id?: number | string; name?: string };
  try {
    order = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const orderId = String(order.id ?? "").trim();
  if (!orderId) return NextResponse.json({ ok: true, skipped: "no order id" });

  const pool = getPool();
  if (!pool) return NextResponse.json({ ok: false, error: "db" }, { status: 500 });

  const ev = await pool.query<{ detail: Array<{ epcs?: string[] }> | null; order_name: string | null }>(
    `SELECT detail, order_name FROM shopify_sale_events WHERE order_id = $1`,
    [orderId],
  );
  const epcs = [...new Set((ev.rows[0]?.detail ?? []).flatMap((d) => (Array.isArray(d.epcs) ? d.epcs : [])))];
  if (!epcs.length) return NextResponse.json({ ok: true, restored: 0, note: "no tags were marked for this order" });
  const name = order.name ?? ev.rows[0]?.order_name ?? orderId;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query<{ epc: string; tenant_id: string }>(
      `UPDATE items i SET status = 'in-stock'
         FROM locations l
        WHERE i.epc = ANY($1::text[]) AND i.status = 'unknown' AND l.id = i.location_id
        RETURNING i.epc, l.tenant_id::text`,
      [epcs],
    );
    for (const row of r.rows) {
      await client.query(
        `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
         VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, 'unknown', 'in-stock', $3, NULL, NULL, 'shopify')`,
        [row.tenant_id, row.epc, `shopify_fulfilled ${name}`],
      );
    }
    await client.query("COMMIT");
    const restored = r.rows.map((x) => x.epc);
    return NextResponse.json({ ok: true, restored: restored.length, epcs: restored, skipped: epcs.length - restored.length });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    // 500 → Shopify retries the delivery.
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "db error" }, { status: 500 });
  } finally {
    client.release();
  }
}

export const POST = withActivity("webhooks/shopify/orders-fulfilled", POST_handler);
