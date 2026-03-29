import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";
import { stableLsSystemIdFromString } from "@/lib/utils/ls-id";
import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";
import {
  credentialsLookUsableForRetailXSeries,
  credentialsLookUsableForRSeries,
} from "@/lib/server/infrastructure-settings-table";
import { mapLightspeedProductJsonToCatalog } from "@/lib/server/lightspeed-catalog-mapper";
import { fetchLightspeedBearer, retailBaseUrl } from "@/lib/server/lightspeed-auth";
import { tryFetchLightspeedRSeriesCatalogProducts } from "@/lib/services/lightspeed-rseries-catalog-fetch";

/**
 * Live catalog: R-Series (`api.lightspeedapp.com`, carbon-gen style) first, then Retail X-Series `/api/2.0/products`.
 * Returns `null` if credentials are incomplete, HTTP fails, or the payload cannot be mapped.
 */
export async function tryFetchLightspeedCatalogProducts(
  creds: LightspeedSyncCredentialRow,
): Promise<CatalogSyncMatrixPayload[] | null> {
  if (credentialsLookUsableForRSeries(creds)) {
    const fromR = await tryFetchLightspeedRSeriesCatalogProducts(creds);
    if (fromR && fromR.length > 0) return fromR;
  }

  if (!credentialsLookUsableForRetailXSeries(creds)) return null;

  const base = retailBaseUrl(creds.domainPrefix);
  const bearer = (await fetchLightspeedBearer(base, creds)) ?? "";
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
