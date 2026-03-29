/**
 * Lightspeed R-Series (REST / MerchantOS-style) OAuth refresh — aligned with carbon-gen `lightspeedApi.ts`.
 * Tries multiple token endpoints (merchantos cloud, retail subdomain, LS_OAUTH_TOKEN_URL).
 */

import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";

const DEFAULT_LS_TOKEN_URL = "https://cloud.merchantos.com/oauth/access_token.php";
const CACHE_FALLBACK_MS = 9 * 60 * 1000;
const LS_FETCH_MAX_RETRIES = 3;

/** Per-credential cache so multiple tenants do not share one R-Series bearer. */
const tokenCacheByKey = new Map<string, { token: string; expiresAt: number }>();

function cacheKeyForCreds(creds: LightspeedSyncCredentialRow): string {
  return [
    normalizeText(creds.clientId),
    normalizeText(creds.accountId),
    normalizeText(creds.refreshToken),
  ].join("\0");
}

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

async function resilientFetch(
  url: string,
  opts: RequestInit,
  timeoutMs = 30_000,
  maxAttempts = LS_FETCH_MAX_RETRIES,
): Promise<Response> {
  const attempts = Math.max(1, maxAttempts);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err: unknown) {
      const msg = String((err as { message?: string })?.message || err);
      const isRetryable = /timeout|abort|network|ECONNRESET|ENOTFOUND|socket hang up|fetch failed/i.test(
        msg,
      );
      if (!isRetryable || attempt >= attempts) throw err;
      await delay(1500 * attempt);
    }
  }
  throw new Error("resilientFetch: exhausted retries");
}

function parseTokenResponseBody(rawText: string): Record<string, unknown> {
  const text = normalizeText(rawText);
  if (!text) return {};

  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }

  const parsedForm = Object.fromEntries(new URLSearchParams(text));
  if (Object.keys(parsedForm).length > 0) return parsedForm as Record<string, unknown>;
  return { raw: text };
}

function getTokenEndpointCandidates(domainPrefix: string): string[] {
  const configuredRaw = normalizeText(process.env.LS_OAUTH_TOKEN_URL || DEFAULT_LS_TOKEN_URL);
  const resolvedConfigured = configuredRaw.replaceAll("<<domain_prefix>>", domainPrefix || "");
  const needsDomainPrefix = configuredRaw.includes("<<domain_prefix>>");
  const candidates: string[] = [];

  if (!needsDomainPrefix || domainPrefix) candidates.push(resolvedConfigured);
  if (domainPrefix) candidates.push(`https://${domainPrefix}.retail.lightspeed.app/api/1.0/token`);

  if (resolvedConfigured.includes("/auth/oauth/token")) {
    candidates.push(resolvedConfigured.replace("/auth/oauth/token", "/oauth/access_token.php"));
  }
  if (resolvedConfigured.includes("/oauth/access_token.php")) {
    candidates.push(resolvedConfigured.replace("/oauth/access_token.php", "/auth/oauth/token"));
  }

  const legacy = [
    "https://cloud.merchantos.com/oauth/access_token.php",
    "https://cloud.merchantos.com/auth/oauth/token",
  ];
  for (const ep of legacy) {
    if (!candidates.includes(ep)) candidates.push(ep);
  }

  return [...new Set(candidates)].filter(Boolean);
}

/**
 * Bearer token for `api.lightspeedapp.com` R-Series API calls (same flow as carbon-gen).
 */
export async function refreshLightspeedRSeriesAccessToken(
  creds: LightspeedSyncCredentialRow,
  forceRefresh = false,
): Promise<string> {
  const key = cacheKeyForCreds(creds);
  const cached = tokenCacheByKey.get(key);
  if (!forceRefresh && cached?.token && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const clientId = normalizeText(creds.clientId);
  const clientSecret = normalizeText(creds.clientSecret);
  const refreshToken = normalizeText(creds.refreshToken);
  const domainPrefix = normalizeText(creds.domainPrefix).toLowerCase();

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Lightspeed R-Series credentials missing (client id, secret, refresh token).");
  }

  const payload = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).toString();

  const endpoints = getTokenEndpointCandidates(domainPrefix);
  let lastError = "Unable to refresh Lightspeed access token.";

  for (const endpoint of endpoints) {
    try {
      const tokenResponse = await resilientFetch(
        endpoint,
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: payload,
        },
        12_000,
      );

      const tokenRawBody = await tokenResponse.text();
      const tokenBody = parseTokenResponseBody(tokenRawBody);

      if (!tokenResponse.ok) {
        lastError = `Unable to refresh token at ${endpoint}: ${JSON.stringify(tokenBody)}`;
        continue;
      }

      const accessToken = normalizeText(tokenBody.access_token);
      if (!accessToken) {
        lastError = `Unable to refresh token at ${endpoint}: access token missing`;
        continue;
      }

      const expiresIn = Number.parseInt(normalizeText(tokenBody.expires_in), 10);
      const ttlMs = Number.isFinite(expiresIn)
        ? Math.max(30, expiresIn - 30) * 1000
        : CACHE_FALLBACK_MS;
      tokenCacheByKey.set(key, { token: accessToken, expiresAt: Date.now() + ttlMs });

      const newRefreshToken = normalizeText(tokenBody.refresh_token);
      if (newRefreshToken && newRefreshToken !== refreshToken) {
        process.env.LS_REFRESH_TOKEN = newRefreshToken;
      }

      return accessToken;
    } catch (error: unknown) {
      lastError = `Unable to refresh token at ${endpoint}: ${String((error as Error)?.message || error)}`;
    }
  }

  throw new Error(lastError);
}
