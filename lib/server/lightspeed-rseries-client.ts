/**
 * Minimal authenticated GET for R-Series `API/Account/{id}/{Resource}.json` (carbon-gen `lsGet` shape).
 */

import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";
import { refreshLightspeedRSeriesAccessToken } from "@/lib/server/lightspeed-rseries-token";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export function buildRSeriesAccountResourceUrl(
  accountId: string,
  resource: string,
  query: Record<string, string | number> = {},
): string {
  const base = normalizeText(process.env.LS_API_BASE || "https://api.lightspeedapp.com").replace(
    /\/+$/,
    "",
  );
  const prefix = /\/API$/i.test(base) ? base : `${base}/API`;
  const endpoint = `${prefix}/Account/${accountId}/${resource}.json`;
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query)) {
    const str = normalizeText(value);
    if (str) url.searchParams.set(key, str);
  }
  return url.toString();
}

/** V3 paths e.g. `Inventory/Transfer` → `…/API/V3/Account/{id}/Inventory/Transfer.json` */
export function buildRSeriesV3AccountResourceUrl(accountId: string, resourcePath: string): string {
  const base = normalizeText(process.env.LS_API_BASE || "https://api.lightspeedapp.com").replace(
    /\/+$/,
    "",
  );
  const apiPath = /\/API\/?V3$/i.test(base) ? base : `${base}/API/V3`;
  const path = resourcePath.replace(/^\/+/, "").replace(/\/+$/, "");
  return `${apiPath}/Account/${accountId}/${path}.json`;
}

export async function rseriesPostJsonV3(
  creds: LightspeedSyncCredentialRow,
  resourcePath: string,
  jsonBody: Record<string, unknown>,
  timeoutMs = 35_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const accountId = creds.accountId.trim();
  if (!accountId) {
    return { ok: false, status: 400, body: { error: "Missing LS_ACCOUNT_ID" } };
  }

  const token = await refreshLightspeedRSeriesAccessToken(creds, false);
  const url = buildRSeriesV3AccountResourceUrl(accountId, resourcePath);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(jsonBody),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let body: unknown = {};
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = { raw: raw.slice(0, 2000) };
  }
  return { ok: res.ok, status: res.status, body };
}

export async function rseriesGetJson(
  creds: LightspeedSyncCredentialRow,
  resource: string,
  query: Record<string, string | number> = {},
  timeoutMs = 25_000,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const accountId = creds.accountId.trim();
  if (!accountId) {
    return { ok: false, status: 400, body: { error: "Missing LS_ACCOUNT_ID" } };
  }

  const token = await refreshLightspeedRSeriesAccessToken(creds, false);
  const url = buildRSeriesAccountResourceUrl(accountId, resource, query);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const raw = await res.text();
  let body: unknown = {};
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    body = { raw: raw.slice(0, 2000) };
  }
  return { ok: res.ok, status: res.status, body };
}
