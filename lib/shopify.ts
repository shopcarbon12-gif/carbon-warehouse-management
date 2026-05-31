const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export function normalizeShopDomain(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  return SHOP_DOMAIN_RE.test(normalized) ? normalized : null;
}

export function toProductGid(productId: string) {
  const trimmed = productId.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("gid://")) return trimmed;
  return `gid://shopify/Product/${trimmed}`;
}

export function getShopifyConfig(baseUrl: string) {
  const rawScopes =
    (process.env.SHOPIFY_SCOPES || "").trim() ||
    "read_products,write_products,write_files,read_locations,write_inventory,read_orders,read_customers,read_publications,write_publications,read_shipping,write_shipping";
  const requiredScopes = [
    "read_shipping",
    "write_shipping",
    "read_online_store_navigation",
    "write_online_store_navigation",
  ];
  const mergedScopes = new Set(
    rawScopes
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean)
  );
  for (const scope of requiredScopes) mergedScopes.add(scope);

  return {
    clientId: (process.env.SHOPIFY_APP_CLIENT_ID || "").trim() || "missing-client-id",
    scopes: Array.from(mergedScopes).join(","),
    redirectUri:
      (process.env.SHOPIFY_REDIRECT_URI || "").trim() || `${baseUrl}/api/shopify/callback`,
    apiVersion: (process.env.SHOPIFY_API_VERSION || "").trim() || "2025-01",
  };
}

export function getShopifyAdminToken(shop: string) {
  const normalizedShop = normalizeShopDomain(shop) || "";
  const key = `SHOPIFY_ADMIN_TOKEN_${normalizedShop.replace(/[.-]/g, "_").toUpperCase()}`;
  const scoped = (process.env[key] || "").trim();
  if (scoped) return scoped;

  const global = (process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "").trim();
  if (!global) return "";

  // Only hand out the global admin token for the explicitly-configured store.
  // Previously, when SHOPIFY_SHOP_DOMAIN was unset the guard fell open and the
  // global token was returned for ANY client-supplied shop domain.
  const configuredShop = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN || "") || "";
  if (!configuredShop || !normalizedShop || configuredShop !== normalizedShop) {
    return "";
  }
  return global;
}

const SHOPIFY_THROTTLE_MAX_RETRIES = 6;
const SHOPIFY_THROTTLE_BASE_DELAY_MS = 1000;
const SHOPIFY_THROTTLE_MAX_DELAY_MS = 15000;

export async function runShopifyGraphql<T>({
  shop,
  token,
  query,
  variables,
  apiVersion,
}: {
  shop: string;
  token: string;
  query: string;
  variables?: Record<string, unknown>;
  apiVersion: string;
}) {
  const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;

  for (let attempt = 0; attempt <= SHOPIFY_THROTTLE_MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables: variables || {} }),
      cache: "no-store",
    });

    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }

    const throttled =
      res.status === 429 ||
      (Array.isArray(json?.errors) &&
        json.errors.some((e: any) => e?.extensions?.code === "THROTTLED"));
    if (throttled && attempt < SHOPIFY_THROTTLE_MAX_RETRIES) {
      // Honor Shopify's pacing signals instead of a blind backoff:
      //   1) the REST-style `Retry-After` header (seconds), then
      //   2) GraphQL cost-based throttling — wait long enough for the
      //      leaky bucket to refill the points this query needs
      //      ((requestedQueryCost - currentlyAvailable) / restoreRate),
      //   3) otherwise exponential backoff.
      // A little jitter avoids thundering-herd retries; capped so we never
      // sleep longer than the route's time budget tolerates.
      const retryAfterSec = Number(res.headers.get("retry-after"));
      const cost = json?.extensions?.cost;
      const throttleStatus = cost?.throttleStatus;
      let delay: number;
      if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
        delay = retryAfterSec * 1000;
      } else if (throttleStatus && Number(throttleStatus.restoreRate) > 0) {
        const needed = Math.max(
          0,
          Number(cost?.requestedQueryCost ?? 0) - Number(throttleStatus.currentlyAvailable ?? 0),
        );
        delay =
          Math.ceil((needed / Number(throttleStatus.restoreRate)) * 1000) ||
          SHOPIFY_THROTTLE_BASE_DELAY_MS;
      } else {
        delay = SHOPIFY_THROTTLE_BASE_DELAY_MS * Math.pow(2, attempt);
      }
      delay = Math.min(SHOPIFY_THROTTLE_MAX_DELAY_MS, delay) + Math.floor(Math.random() * 250);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    if (!res.ok) {
      return {
        ok: false as const,
        status: res.status,
        errors: json?.errors || json,
        data: null as T | null,
      };
    }

    if (Array.isArray(json?.errors) && json.errors.length > 0) {
      return {
        ok: false as const,
        status: 400,
        errors: json.errors,
        data: json?.data ?? null,
      };
    }

    return {
      ok: true as const,
      status: 200,
      errors: null,
      data: (json?.data ?? null) as T | null,
    };
  }

  return {
    ok: false as const,
    status: 429,
    errors: [{ message: "Shopify API throttled after max retries" }],
    data: null as T | null,
  };
}
