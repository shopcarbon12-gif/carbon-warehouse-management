import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";

export function retailBaseUrl(domainPrefix: string): string {
  const p = domainPrefix.replace(/\.retail\.lightspeed\.app$/i, "").trim();
  return `https://${p}.retail.lightspeed.app`;
}

async function fetchAccessTokenRefresh(
  baseUrl: string,
  creds: LightspeedSyncCredentialRow,
): Promise<string | null> {
  if (!creds.clientId || !creds.clientSecret || !creds.refreshToken) return null;
  const tokenUrl = `${baseUrl}/api/1.0/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
  });
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!res.ok) return null;
  const j = (await res.json().catch(() => null)) as { access_token?: string } | null;
  const t = j?.access_token?.trim();
  return t || null;
}

/**
 * Bearer for Retail (X-Series) API calls: personal token if set, else OAuth2 refresh_token grant.
 */
export async function fetchLightspeedBearer(
  baseUrl: string,
  creds: LightspeedSyncCredentialRow,
): Promise<string | null> {
  const personal = creds.personalToken.trim();
  if (personal) return personal;
  return fetchAccessTokenRefresh(baseUrl, creds);
}
