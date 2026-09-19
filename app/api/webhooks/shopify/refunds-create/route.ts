import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-webhook";
import { applyShopifyRefund, type ShopifyRefundPayload } from "@/lib/server/shopify-refund-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify refunds/create webhook — puts back what orders/paid took when an
 * order is refunded and restocked. See lib/server/shopify-refund-sync.ts.
 *
 * Public route (no WMS session) — authenticated by Shopify HMAC. Idempotent per
 * refund id via shopify_refund_events.
 *
 * Unlike orders/paid, the claim and the stock changes share one transaction: a
 * failure rolls the claim back too, the 500 makes Shopify retry, and the retry
 * is not mistaken for a duplicate.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhookHmac(raw, hmac)) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  let refund: ShopifyRefundPayload;
  try {
    refund = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ ok: false, error: "db" }, { status: 500 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await applyShopifyRefund(client, refund);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[webhooks/shopify/refunds-create]", e);
    return NextResponse.json({ ok: false, error: "refund sync failed" }, { status: 500 });
  } finally {
    client.release();
  }
}
