import { NextResponse } from "next/server";
import { verifyShopifyWebhook } from "@/lib/shopify-webhook";
import { wmsLog } from "@/lib/log";

export async function POST(req: Request) {
  const raw = Buffer.from(await req.arrayBuffer());
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  if (!verifyShopifyWebhook(raw, hmac)) {
    wmsLog("warn", "shopify_webhook_rejected", { reason: "bad_hmac" });
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const topic =
    req.headers.get("x-shopify-topic") ??
    req.headers.get("x-shopify-event-id") ??
    "unknown";

  wmsLog("info", "shopify_webhook_ok", { topic });
  return NextResponse.json({ ok: true });
}
