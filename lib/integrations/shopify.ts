/**
 * Shopify Admin API — inventory & fulfillment sync (configure SHOPIFY_* env).
 * https://shopify.dev/docs/api/admin-rest
 */
const domain = () => process.env.SHOPIFY_STORE_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/$/, "");
const token = () => process.env.SHOPIFY_ACCESS_TOKEN;

export function shopifyConfigured(): boolean {
  return Boolean(domain() && token());
}

export async function shopifyHealthPing(): Promise<{ ok: boolean; detail?: string }> {
  if (!shopifyConfigured()) {
    return { ok: false, detail: "SHOPIFY_STORE_DOMAIN or SHOPIFY_ACCESS_TOKEN missing" };
  }
  const d = domain()!;
  const url = `https://${d}/admin/api/2024-10/shop.json`;
  const res = await fetch(url, {
    headers: {
      "X-Shopify-Access-Token": token()!,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) {
    return { ok: false, detail: `HTTP ${res.status}` };
  }
  return { ok: true };
}
