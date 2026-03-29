import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";
import { stableLsSystemIdFromString } from "@/lib/utils/ls-id";
import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";
import { mapLightspeedProductJsonToCatalog } from "@/lib/server/lightspeed-catalog-mapper";

async function fetchAccessTokenRetail(
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

function retailBaseUrl(domainPrefix: string): string {
  const p = domainPrefix.replace(/\.retail\.lightspeed\.app$/i, "").trim();
  return `https://${p}.retail.lightspeed.app`;
}

/**
 * Attempts Lightspeed Retail (X-Series) `GET /api/2.0/products` (Bearer token).
 * Returns `null` if credentials are incomplete, HTTP fails, or the payload cannot be mapped.
 */
export async function tryFetchLightspeedCatalogProducts(
  creds: LightspeedSyncCredentialRow,
): Promise<CatalogSyncMatrixPayload[] | null> {
  if (!creds.domainPrefix) return null;

  const base = retailBaseUrl(creds.domainPrefix);
  let bearer = creds.personalToken.trim();
  if (!bearer) {
    bearer = (await fetchAccessTokenRetail(base, creds)) ?? "";
  }
  if (!bearer) return null;

  const url = `${base}/api/2.0/products?limit=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "application/json",
      "User-Agent": "CarbonWMS/1.0",
    },
  });
  if (!res.ok) return null;
  const json: unknown = await res.json().catch(() => null);
  return mapLightspeedProductJsonToCatalog(json, stableLsSystemIdFromString);
}
