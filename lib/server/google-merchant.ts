/**
 * Google Merchant Center (Merchant API v1) + Google Ads (read-only) helpers for
 * the "Sync ads" job.
 *
 * One OAuth client + refresh token (the shopcarbon12 Google login) covers both
 * APIs: GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / GOOGLE_ADS_REFRESH_TOKEN.
 * Google Ads reads also need GOOGLE_ADS_DEVELOPER_TOKEN + GOOGLE_ADS_CUSTOMER_ID.
 *
 * Ad-group tags are written as custom labels into a SUPPLEMENTAL data source
 * (GMC_LABELS_DATA_SOURCE), which is linked into every primary feed, so the
 * Shopify app's own feed stays untouched.
 */

const MERCHANT = "https://merchantapi.googleapis.com";
const ADS = "https://googleads.googleapis.com/v25";

export function merchantId(): string {
  return (process.env.GMC_MERCHANT_ID || "").trim() || "779385360";
}
export function labelsDataSource(): string {
  return (
    (process.env.GMC_LABELS_DATA_SOURCE || "").trim() ||
    `accounts/${merchantId()}/dataSources/10768074810`
  );
}

export function googleConfigured(): boolean {
  return ["GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET", "GOOGLE_ADS_REFRESH_TOKEN"].every((k) =>
    (process.env[k] || "").trim(),
  );
}

let cached: { token: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  if (cached && cached.until > Date.now()) return cached.token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: (process.env.GOOGLE_ADS_CLIENT_ID || "").trim(),
      client_secret: (process.env.GOOGLE_ADS_CLIENT_SECRET || "").trim(),
      refresh_token: (process.env.GOOGLE_ADS_REFRESH_TOKEN || "").trim(),
      grant_type: "refresh_token",
    }),
    cache: "no-store",
  });
  const j = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!j.access_token) throw new Error(`Google login failed: ${j.error_description || j.error || res.status}`);
  cached = { token: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 120) * 1000 };
  return j.access_token;
}

async function gfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = await accessToken();
  for (let a = 0; a < 5; a++) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
      cache: "no-store",
    });
    if (res.status !== 429 && res.status < 500) return res;
    await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
  }
  throw new Error(`Google API kept failing: ${url.split("?")[0]}`);
}

export type GmcListing = {
  name: string;
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  dataSource: string;
  /** customLabel0..4 as Google currently has them (merged from all sources). */
  labels: Array<string | null>;
  material: string | null;
  productDetails: Array<{ sectionName?: string; attributeName?: string; attributeValue?: string }>;
};

/** Every listing in the Merchant Center account. */
export async function listGmcListings(): Promise<GmcListing[]> {
  const out: GmcListing[] = [];
  let pageToken = "";
  do {
    const res = await gfetch(
      `${MERCHANT}/products/v1/accounts/${merchantId()}/products?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    );
    const j = (await res.json()) as {
      products?: Array<{
        name: string;
        offerId: string;
        contentLanguage: string;
        feedLabel: string;
        dataSource: string;
        productAttributes?: Record<string, unknown>;
      }>;
      nextPageToken?: string;
      error?: { message?: string };
    };
    if (j.error) throw new Error(`Merchant Center: ${j.error.message}`);
    for (const p of j.products || []) {
      const a = p.productAttributes || {};
      out.push({
        name: p.name,
        offerId: p.offerId,
        contentLanguage: p.contentLanguage,
        feedLabel: p.feedLabel,
        dataSource: p.dataSource,
        labels: [0, 1, 2, 3, 4].map((i) => {
          const v = a[`customLabel${i}`];
          return typeof v === "string" && v ? v : null;
        }),
        material: typeof a.material === "string" ? a.material : null,
        productDetails: Array.isArray(a.productDetails) ? (a.productDetails as GmcListing["productDetails"]) : [],
      });
    }
    pageToken = j.nextPageToken || "";
  } while (pageToken);
  return out;
}

type ListingKey = Pick<GmcListing, "offerId" | "contentLanguage" | "feedLabel">;

/**
 * Field-scoped write into our supplemental data source.
 *
 * Several writers share this source — ad labels (Sync ads) and product details
 * (fabric / care / model). productInputs:insert REPLACES the whole input, so
 * each writer patches only its own fields (updateMask); a field in the mask
 * with no value is removed. When the listing has no input in this source yet,
 * patch 404s and the input is created with just these fields.
 */
async function patchSupplemental(
  l: ListingKey,
  attrs: Record<string, unknown>,
  fields: string[],
): Promise<{ ok: boolean; error?: string }> {
  const id = `${l.contentLanguage}~${l.feedLabel}~${l.offerId}`;
  const mask = fields.map((f) => `productAttributes.${f}`).join(",");
  const res = await gfetch(
    `${MERCHANT}/products/v1/accounts/${merchantId()}/productInputs/${encodeURIComponent(id)}?dataSource=${encodeURIComponent(labelsDataSource())}&updateMask=${encodeURIComponent(mask)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ offerId: l.offerId, contentLanguage: l.contentLanguage, feedLabel: l.feedLabel, productAttributes: attrs }),
    },
  );
  if (res.ok) return { ok: true };
  if (res.status !== 404) return { ok: false, error: (await res.text()).slice(0, 200) };
  const values = Object.fromEntries(Object.entries(attrs).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  if (!Object.keys(values).length) return { ok: true }; // nothing to clear on a missing input
  const ins = await gfetch(
    `${MERCHANT}/products/v1/accounts/${merchantId()}/productInputs:insert?dataSource=${encodeURIComponent(labelsDataSource())}`,
    {
      method: "POST",
      body: JSON.stringify({ offerId: l.offerId, contentLanguage: l.contentLanguage, feedLabel: l.feedLabel, productAttributes: values }),
    },
  );
  return ins.ok ? { ok: true } : { ok: false, error: (await ins.text()).slice(0, 200) };
}

/** Write our supplemental custom labels for one listing (other fields kept). */
export async function setGmcLabels(l: ListingKey, labels: Record<number, string>): Promise<{ ok: boolean; error?: string }> {
  const productAttributes: Record<string, string> = {};
  for (const [slot, v] of Object.entries(labels)) productAttributes[`customLabel${slot}`] = v;
  return patchSupplemental(l, productAttributes, Object.keys(productAttributes));
}

/** Remove our supplemental labels for one listing (it no longer belongs to any group). */
export async function clearGmcLabels(l: ListingKey, slots: number[] = [0, 1, 2, 3, 4]): Promise<{ ok: boolean; error?: string }> {
  return patchSupplemental(l, {}, slots.map((s) => `customLabel${s}`));
}

/** Product details for one listing: `material` + `productDetails` (fabric, care, model height). */
export async function setGmcDetails(
  l: ListingKey,
  d: { material: string | null; productDetails: Array<{ sectionName: string; attributeName: string; attributeValue: string }> },
): Promise<{ ok: boolean; error?: string }> {
  return patchSupplemental(
    l,
    { material: d.material || undefined, productDetails: d.productDetails.length ? d.productDetails : undefined },
    ["material", "productDetails"],
  );
}

export function googleAdsConfigured(): boolean {
  return googleConfigured() && Boolean((process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim());
}

function adsCustomerId(): string {
  return ((process.env.GOOGLE_ADS_CUSTOMER_ID || "").trim() || "7374728972").replace(/-/g, "");
}

async function adsSearch<T>(query: string): Promise<T[]> {
  const res = await gfetch(`${ADS}/customers/${adsCustomerId()}/googleAds:search`, {
    method: "POST",
    headers: { "developer-token": (process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim() },
    body: JSON.stringify({ query }),
  });
  const j = (await res.json()) as { results?: T[]; error?: { message?: string } };
  if (j.error) throw new Error(`Google Ads: ${j.error.message}`);
  return j.results || [];
}

export type LabelUse = { slot: number; value: string; campaign: string; status: string };

/**
 * Which live Google campaigns select products by a custom label — Performance
 * Max listing-group filters and Standard Shopping listing groups. Lets the
 * report say "used by campaign X" for any campaign, current or future.
 */
export async function googleCampaignLabelUse(): Promise<LabelUse[]> {
  type Pmax = {
    campaign: { name: string; status: string };
    assetGroupListingGroupFilter?: {
      caseValue?: { productCustomAttribute?: { index?: string; value?: string } };
    };
  };
  type Std = {
    campaign: { name: string; status: string };
    adGroupCriterion?: {
      listingGroup?: { caseValue?: { productCustomAttribute?: { index?: string; value?: string } } };
    };
  };
  const idx = (s?: string) => {
    const m = /INDEX(\d)/.exec(s || "");
    return m ? Number(m[1]) : -1;
  };
  const out: LabelUse[] = [];
  const pmax = await adsSearch<Pmax>(
    `SELECT campaign.name, campaign.status, asset_group_listing_group_filter.case_value.product_custom_attribute.index, asset_group_listing_group_filter.case_value.product_custom_attribute.value FROM asset_group_listing_group_filter WHERE campaign.status != 'REMOVED' AND asset_group_listing_group_filter.case_value.product_custom_attribute.value IS NOT NULL`,
  ).catch(() => [] as Pmax[]);
  for (const r of pmax) {
    const a = r.assetGroupListingGroupFilter?.caseValue?.productCustomAttribute;
    if (a?.value) out.push({ slot: idx(a.index), value: a.value.toLowerCase(), campaign: r.campaign.name, status: r.campaign.status });
  }
  const std = await adsSearch<Std>(
    `SELECT campaign.name, campaign.status, ad_group_criterion.listing_group.case_value.product_custom_attribute.index, ad_group_criterion.listing_group.case_value.product_custom_attribute.value FROM ad_group_criterion WHERE ad_group_criterion.type = 'LISTING_GROUP' AND campaign.status != 'REMOVED' AND ad_group_criterion.listing_group.case_value.product_custom_attribute.value IS NOT NULL`,
  ).catch(() => [] as Std[]);
  for (const r of std) {
    const a = r.adGroupCriterion?.listingGroup?.caseValue?.productCustomAttribute;
    if (a?.value) out.push({ slot: idx(a.index), value: a.value.toLowerCase(), campaign: r.campaign.name, status: r.campaign.status });
  }
  return out;
}
