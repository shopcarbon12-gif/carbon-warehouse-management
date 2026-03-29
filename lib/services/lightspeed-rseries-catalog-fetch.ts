/**
 * Pull R-Series (api.lightspeedapp.com) Item catalog — same strategy as carbon-gen catalog route:
 * V3 ItemMatrix → V3 Item → legacy offset Item pages.
 */

import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";
import type { LightspeedSyncCredentialRow } from "@/lib/server/infrastructure-settings-table";
import { mapRseriesRawItemsToCatalogSync } from "@/lib/server/lightspeed-rseries-catalog-mapper";
import { refreshLightspeedRSeriesAccessToken } from "@/lib/server/lightspeed-rseries-token";

const LS_V3_PAGE_LIMIT = 100;
const LS_V3_MAX_PAGES = Math.min(Number(process.env.LS_MAX_CATALOG_PAGES) || 80, 250);
const LS_ITEM_PAGE_LIMIT = 1000;
const LS_ITEM_PAGE_LIMIT_FALLBACK = 500;
const LS_ITEM_PAGE_LIMIT_LAST_RESORT = 100;
const LS_RATE_LIMIT_RETRY_ATTEMPTS = 3;
const LS_MIN_REQUEST_INTERVAL_MS = 250;
const LS_FETCH_MAX_RETRIES = 3;

let lightspeedRequestChain: Promise<void> = Promise.resolve();
let lightspeedLastRequestAt = 0;

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function toArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
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

async function waitForLightspeedRequestSlot(): Promise<void> {
  const next = lightspeedRequestChain.then(async () => {
    const now = Date.now();
    const waitMs = Math.max(0, LS_MIN_REQUEST_INTERVAL_MS - (now - lightspeedLastRequestAt));
    if (waitMs > 0) await delay(waitMs);
    lightspeedLastRequestAt = Date.now();
  });
  lightspeedRequestChain = next.catch(() => undefined);
  await next;
}

function getRSeriesResourceEndpoint(resource: string, accountId: string): string {
  const base = normalizeText(process.env.LS_API_BASE || "https://api.lightspeedapp.com").replace(
    /\/+$/,
    "",
  );
  if (/\/API$/i.test(base)) {
    return `${base}/Account/${accountId}/${resource}.json`;
  }
  return `${base}/API/Account/${accountId}/${resource}.json`;
}

function getRSeriesV3ResourceEndpoint(resource: string, accountId: string): string {
  const base = normalizeText(process.env.LS_API_BASE || "https://api.lightspeedapp.com").replace(
    /\/+$/,
    "",
  );
  const apiPath = /\/API\/?V3$/i.test(base) ? base : `${base}/API/V3`;
  return `${apiPath}/Account/${accountId}/${resource}.json`;
}

function buildRSeriesUrl(resource: string, accountId: string, query: Record<string, string | number> = {}) {
  const endpoint = getRSeriesResourceEndpoint(resource, accountId);
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(query)) {
    const strValue = normalizeText(value);
    if (!strValue) continue;
    url.searchParams.set(key, strValue);
  }
  return url;
}

function parseRSeriesListResponse<T>(resource: string, parsedBody: Record<string, unknown>) {
  const list = toArray(parsedBody[resource] as T | T[] | undefined) as T[];
  const total = Number.parseInt(normalizeText((parsedBody["@attributes"] as Record<string, unknown>)?.count), 10);
  return {
    rows: list,
    totalCount: Number.isFinite(total) ? total : list.length,
  };
}

function readResponseError(parsedBody: unknown, rawBody: string, fallback = "request failed"): string {
  const p = parsedBody as Record<string, unknown>;
  return (
    normalizeText(p?.message) ||
    normalizeText(p?.error) ||
    normalizeText(p?.error_description) ||
    normalizeText(rawBody) ||
    fallback
  );
}

async function requestRSeriesList<T>(params: {
  accessToken: string;
  accountId: string;
  resource: string;
  query?: Record<string, string | number>;
}): Promise<{ rows: T[]; totalCount: number }> {
  const { accessToken, accountId, resource } = params;
  const url = buildRSeriesUrl(resource, accountId, params.query ?? {});

  let lastError = `Lightspeed ${resource} request failed.`;

  for (let attempt = 1; attempt <= LS_RATE_LIMIT_RETRY_ATTEMPTS; attempt += 1) {
    await waitForLightspeedRequestSlot();

    const response = await resilientFetch(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      20_000,
    );

    const rawBody = await response.text();
    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      parsedBody = { raw: rawBody };
    }

    if (response.ok) {
      return parseRSeriesListResponse<T>(resource, parsedBody);
    }

    const detail = readResponseError(parsedBody, rawBody);
    const isRateLimited = response.status === 429 || /rate\s*limit/i.test(detail);
    lastError = `Lightspeed ${resource} request failed: ${detail}`;

    if (!isRateLimited || attempt >= LS_RATE_LIMIT_RETRY_ATTEMPTS) {
      throw new Error(lastError);
    }

    const retryAfterRaw = normalizeText(response.headers.get("retry-after"));
    const retryAfterSeconds = Number.parseFloat(retryAfterRaw);
    const retryWaitMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(1000, Math.round(retryAfterSeconds * 1000))
      : 1200 * attempt;
    await delay(retryWaitMs);
  }

  throw new Error(lastError);
}

async function requestRSeriesParallel<T>(params: {
  accessToken: string;
  accountId: string;
  resource: string;
  query: Record<string, string | number>;
}): Promise<{ rows: T[]; totalCount: number }> {
  const { accessToken, accountId, resource } = params;
  const url = buildRSeriesUrl(resource, accountId, params.query);

  let lastError = `Lightspeed ${resource} request failed.`;

  for (let attempt = 1; attempt <= LS_RATE_LIMIT_RETRY_ATTEMPTS; attempt += 1) {
    const response = await resilientFetch(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      25_000,
    );

    const rawBody = await response.text();
    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      parsedBody = { raw: rawBody };
    }

    if (response.ok) {
      return parseRSeriesListResponse<T>(resource, parsedBody);
    }

    const detail = readResponseError(parsedBody, rawBody);
    const isRateLimited = response.status === 429 || /rate\s*limit/i.test(detail);
    lastError = `Lightspeed ${resource} request failed: ${detail}`;

    if (!isRateLimited || attempt >= LS_RATE_LIMIT_RETRY_ATTEMPTS) {
      throw new Error(lastError);
    }

    const retryAfterRaw = normalizeText(response.headers.get("retry-after"));
    const retryAfterSeconds = Number.parseFloat(retryAfterRaw);
    const retryWaitMs = Number.isFinite(retryAfterSeconds)
      ? Math.max(1000, Math.round(retryAfterSeconds * 1000))
      : 2000 * attempt;
    await delay(retryWaitMs);
  }

  throw new Error(lastError);
}

function resolveNextUrl(next: string, base: string): string | null {
  const t = normalizeText(next);
  if (!t) return null;
  if (/^https?:/i.test(t)) return t;
  try {
    const baseUrl = new URL(base);
    return new URL(t, baseUrl.origin).toString();
  } catch {
    return t.startsWith("/") ? `${new URL(base).origin}${t}` : null;
  }
}

async function loadCategoryMap(accessToken: string, accountId: string): Promise<Record<string, string>> {
  const categoryNameById: Record<string, string> = {};
  let offset = 0;
  const limit = 100;
  let totalCount = Number.POSITIVE_INFINITY;
  let guard = 0;

  while (offset < totalCount && guard < 500) {
    const page = await requestRSeriesList<Record<string, unknown>>({
      accessToken,
      accountId,
      resource: "Category",
      query: { limit, offset },
    });
    totalCount = page.totalCount;
    for (const row of page.rows) {
      const id = normalizeText(row?.categoryID);
      const rawLabel = normalizeText(row?.fullPathName || row?.name);
      if (!id || !rawLabel) continue;
      categoryNameById[id] = rawLabel.replace(/[\\/]/g, " >> ");
    }
    if (page.rows.length === 0) break;
    offset += limit;
    guard += 1;
  }
  return categoryNameById;
}

async function loadManufacturerMap(accessToken: string, accountId: string): Promise<Record<string, string>> {
  const manufacturerNameById: Record<string, string> = {};
  let offset = 0;
  const limit = 100;
  let totalCount = Number.POSITIVE_INFINITY;
  let guard = 0;

  while (offset < totalCount && guard < 500) {
    const page = await requestRSeriesList<Record<string, unknown>>({
      accessToken,
      accountId,
      resource: "Manufacturer",
      query: { limit, offset },
    });
    totalCount = page.totalCount;
    for (const row of page.rows) {
      const id = normalizeText(row?.manufacturerID);
      const name = normalizeText(row?.name);
      if (!id || !name) continue;
      manufacturerNameById[id] = name;
    }
    if (page.rows.length === 0) break;
    offset += limit;
    guard += 1;
  }
  return manufacturerNameById;
}

async function fetchRawCatalogFromItemMatrix(
  accessToken: string,
  accountId: string,
): Promise<Record<string, unknown>[] | null> {
  const endpoint = getRSeriesV3ResourceEndpoint("ItemMatrix", accountId);
  const url = new URL(endpoint);
  url.searchParams.set("limit", String(LS_V3_PAGE_LIMIT));
  url.searchParams.set("archived", "false");
  url.searchParams.set("load_relations", '["Items","Items.ItemShops","Items.ItemAttributes"]');
  url.searchParams.set("sort", "itemMatrixID");

  const rawItems: Record<string, unknown>[] = [];
  let nextUrl: string | null = url.toString();
  let pages = 0;

  while (nextUrl && pages < LS_V3_MAX_PAGES) {
    await waitForLightspeedRequestSlot();

    const response = await resilientFetch(
      nextUrl,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      30_000,
    );

    const rawBody = await response.text();
    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      parsedBody = { raw: rawBody };
    }

    if (!response.ok) {
      const detail = readResponseError(parsedBody, rawBody);
      throw new Error(`Lightspeed ItemMatrix (V3) request failed: ${detail}`);
    }

    const matrices = toArray(parsedBody.ItemMatrix) as Record<string, unknown>[];
    for (const matrix of matrices) {
      const itemsRaw = matrix?.Items;
      const items = Array.isArray(itemsRaw)
        ? itemsRaw
        : toArray((itemsRaw as { Item?: unknown })?.Item) as Record<string, unknown>[];
      for (const it of items) {
        if (it && typeof it === "object" && (it.itemID || it.systemSku || it.customSku)) {
          rawItems.push(it as Record<string, unknown>);
        }
      }
    }
    pages += 1;

    const attrs = parsedBody["@attributes"] as Record<string, unknown> | undefined;
    const next = resolveNextUrl(normalizeText(attrs?.next), nextUrl);
    nextUrl = next;
  }

  return rawItems.length > 0 ? rawItems : null;
}

async function fetchRawCatalogItemsV3(
  accessToken: string,
  accountId: string,
): Promise<Record<string, unknown>[] | null> {
  const endpoint = getRSeriesV3ResourceEndpoint("Item", accountId);
  const url = new URL(endpoint);
  url.searchParams.set("limit", String(LS_V3_PAGE_LIMIT));
  url.searchParams.set("archived", "false");
  url.searchParams.set("load_relations", '["ItemShops","ItemAttributes"]');
  url.searchParams.set("sort", "itemID");

  const rawItems: Record<string, unknown>[] = [];
  let nextUrl: string | null = url.toString();
  let pages = 0;

  while (nextUrl && pages < LS_V3_MAX_PAGES) {
    await waitForLightspeedRequestSlot();

    const response = await resilientFetch(
      nextUrl,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      },
      30_000,
    );

    const rawBody = await response.text();
    let parsedBody: Record<string, unknown> = {};
    try {
      parsedBody = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      parsedBody = { raw: rawBody };
    }

    if (!response.ok) {
      const detail = readResponseError(parsedBody, rawBody);
      throw new Error(`Lightspeed Item (V3) request failed: ${detail}`);
    }

    const list = toArray(parsedBody.Item) as Record<string, unknown>[];
    rawItems.push(...list);
    pages += 1;

    const attrs = parsedBody["@attributes"] as Record<string, unknown> | undefined;
    const next = resolveNextUrl(normalizeText(attrs?.next), nextUrl);
    nextUrl = next;
  }

  return rawItems.length > 0 ? rawItems : null;
}

async function tryFirstItemPage(accessToken: string, accountId: string, pageLimit: number) {
  return requestRSeriesList<Record<string, unknown>>({
    accessToken,
    accountId,
    resource: "Item",
    query: {
      limit: pageLimit,
      offset: 0,
      archived: "false",
      load_relations: '["ItemShops","ItemAttributes"]',
    },
  });
}

async function resolvePageLimit(accessToken: string, accountId: string) {
  const limits = [LS_ITEM_PAGE_LIMIT, LS_ITEM_PAGE_LIMIT_FALLBACK, LS_ITEM_PAGE_LIMIT_LAST_RESORT];

  for (let i = 0; i < limits.length; i++) {
    try {
      const firstPage = await tryFirstItemPage(accessToken, accountId, limits[i]!);
      return { firstPage, pageLimit: limits[i]! };
    } catch (error: unknown) {
      const message = String((error as Error)?.message || "");
      const likelyLimitError = /limit|invalid|parameter|too\s+large|maximum/i.test(message);
      if (!likelyLimitError || i === limits.length - 1) throw error;
    }
  }

  throw new Error("Unable to load Lightspeed item catalog.");
}

async function fetchRawCatalogItemsLegacy(
  accessToken: string,
  accountId: string,
): Promise<Record<string, unknown>[]> {
  const { firstPage, pageLimit } = await resolvePageLimit(accessToken, accountId);

  const buildBaseQuery = (limit: number) => ({
    limit,
    archived: "false",
    load_relations: '["ItemShops","ItemAttributes"]',
  });

  const rawItems: Record<string, unknown>[] = [...firstPage.rows];
  const totalCount = firstPage.totalCount;
  const offsets: number[] = [];
  for (let offset = pageLimit; offset < totalCount; offset += pageLimit) {
    offsets.push(offset);
  }

  const concurrency = 6;
  for (let i = 0; i < offsets.length; i += concurrency) {
    const chunk = offsets.slice(i, i + concurrency);
    const pages = await Promise.all(
      chunk.map((offset) =>
        requestRSeriesParallel<Record<string, unknown>>({
          accessToken,
          accountId,
          resource: "Item",
          query: { ...buildBaseQuery(pageLimit), offset },
        }),
      ),
    );
    for (const page of pages) {
      rawItems.push(...page.rows);
    }
  }

  return rawItems;
}

async function fetchRawCatalogItems(
  accessToken: string,
  accountId: string,
): Promise<Record<string, unknown>[]> {
  try {
    const matrixResult = await fetchRawCatalogFromItemMatrix(accessToken, accountId);
    if (matrixResult && matrixResult.length > 0) return matrixResult;
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || "");
    if (!/v3|version|not found|404|ItemMatrix/i.test(msg)) {
      console.warn("[WMS Lightspeed R-Series] ItemMatrix fetch failed, trying Item V3:", msg);
    }
  }

  try {
    const v3Result = await fetchRawCatalogItemsV3(accessToken, accountId);
    if (v3Result && v3Result.length > 0) return v3Result;
  } catch (e: unknown) {
    const msg = String((e as Error)?.message || "");
    if (!/v3|version|not found|404/i.test(msg)) {
      console.warn("[WMS Lightspeed R-Series] V3 Item fetch failed, falling back to legacy:", msg);
    }
  }

  return fetchRawCatalogItemsLegacy(accessToken, accountId);
}

/**
 * Returns WMS catalog matrices from Lightspeed R-Series when OAuth + account id succeed.
 */
export async function tryFetchLightspeedRSeriesCatalogProducts(
  creds: LightspeedSyncCredentialRow,
): Promise<CatalogSyncMatrixPayload[] | null> {
  const accountId = normalizeText(creds.accountId);
  if (!accountId) return null;

  try {
    const accessToken = await refreshLightspeedRSeriesAccessToken(creds, false);
    const [categoryNameById, manufacturerNameById, rawItems] = await Promise.all([
      loadCategoryMap(accessToken, accountId),
      loadManufacturerMap(accessToken, accountId),
      fetchRawCatalogItems(accessToken, accountId),
    ]);

    return mapRseriesRawItemsToCatalogSync(rawItems, categoryNameById, manufacturerNameById);
  } catch (e: unknown) {
    console.warn("[WMS Lightspeed R-Series] catalog fetch failed:", (e as Error)?.message || e);
    return null;
  }
}
