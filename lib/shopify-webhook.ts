import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies Shopify `X-Shopify-Hmac-Sha256` against raw body bytes.
 * Set SHOPIFY_WEBHOOK_SECRET in Coolify from the app’s Admin API client secret.
 */
export function verifyShopifyWebhook(
  rawBody: Buffer,
  hmacHeader: string | null,
): boolean {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET?.trim();
  if (!secret || !hmacHeader) return false;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(digest, "utf8");
  const b = Buffer.from(hmacHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
