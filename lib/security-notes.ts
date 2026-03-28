/**
 * Security expectations (Coolify / production):
 * - Every authenticated API route must load the session and scope queries by `session.tid`
 *   and, where applicable, `session.lid` (see `getSession()`).
 * - Never return another tenant’s rows: always pass tenant/location IDs into SQL as parameters.
 * - Integration tokens belong in `integration_connections.credentials_encrypted` (encrypt at rest).
 * - Shopify webhooks: verify `X-Shopify-Hmac-Sha256` before trusting the body (`lib/shopify-webhook.ts`).
 * - Handheld: require `X-WMS-Device-Key` matching `WMS_DEVICE_KEY`.
 */

export const SECURITY_SCOPE_DOC = true;
