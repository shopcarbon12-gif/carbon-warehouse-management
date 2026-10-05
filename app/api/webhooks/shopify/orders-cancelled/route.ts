import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-webhook";
import { expireThankYouCodeForOrder } from "@/lib/server/packing-slip/thank-you-code";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify orders/cancelled webhook — an order was cancelled, for any reason.
 *
 * Its thank-you code (15% off the next order, created when the packing slip
 * was printed) is expired immediately: deactivated in Shopify and hidden from
 * the customer's Rewards page. Re-delivery is harmless.
 *
 * Public route (no WMS session) — authenticated by Shopify HMAC.
 */
async function POST_handler(req: Request) {
  const raw = await req.text();
  if (!verifyShopifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  let order: { id?: number | string; name?: string; cancel_reason?: string | null };
  try {
    order = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const orderId = String(order.id ?? "").trim();
  if (!/^\d+$/.test(orderId)) return NextResponse.json({ ok: true, skipped: "no order id" });
  const pool = getPool();
  if (!pool) return NextResponse.json({ ok: false, error: "db" }, { status: 500 });

  const r = await expireThankYouCodeForOrder(
    pool,
    orderId,
    `order ${order.name ?? orderId} cancelled${order.cancel_reason ? ` (${order.cancel_reason})` : ""}`,
  );
  // A failure returns 500 so Shopify retries the delivery.
  if (r.status === "failed") return NextResponse.json({ ok: false, thankYouCode: r }, { status: 500 });
  return NextResponse.json({ ok: true, thankYouCode: r });
}

export const POST = withActivity("webhooks/shopify/orders-cancelled", POST_handler);
