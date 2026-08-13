import crypto from "crypto";

/**
 * Verify a Shopify webhook HMAC (base64 HMAC-SHA256 of the RAW request body,
 * compared to the `X-Shopify-Hmac-Sha256` header). The secret is the Shopify
 * app's client secret — `SHOPIFY_WEBHOOK_SECRET` (falls back to
 * `SHOPIFY_APP_CLIENT_SECRET`). Timing-safe compare.
 */
export function verifyShopifyWebhookHmac(rawBody: string, hmacHeader: string | null): boolean {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_APP_CLIENT_SECRET || "";
  if (!secret || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  try {
    const a = Buffer.from(digest);
    const b = Buffer.from(hmacHeader);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
