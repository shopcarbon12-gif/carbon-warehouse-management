import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { verifyShopifyWebhookHmac } from "@/lib/shopify-webhook";
import { findGid, onReturnProcessed } from "@/lib/server/shopify-returns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify RETURNS_PROCESS webhook — A return was processed — exchange items released.
 * See lib/server/shopify-returns.ts. Public route, authenticated by Shopify HMAC;
 * a 500 makes Shopify retry, and the work is idempotent.
 */
async function POST_handler(req: Request) {
  const raw = await req.text();
  if (!verifyShopifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"))) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 });
  }
  const gid = findGid(payload, "Return");
  if (!gid) return NextResponse.json({ ok: true, skipped: "no Return id in payload" });
  const pool = getPool();
  if (!pool) return NextResponse.json({ ok: false, error: "db" }, { status: 500 });
  try {
    return NextResponse.json(await onReturnProcessed(pool, gid));
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export const POST = withActivity("webhooks/shopify/returns-process", POST_handler);
