/**
 * Meta (Facebook/Instagram) catalog helpers for the "Sync ads" job.
 *
 * META_SYSTEM_USER_TOKEN (business system user, never expires), META_CATALOG_ID
 * (the Shopify-fed catalog) and META_AD_ACCOUNT_ID. Product sets are rule-based
 * filters, so once a set exists Meta keeps it current as stock changes; the job
 * only creates/updates the filter and reports counts and which ad sets use it.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export function metaConfigured(): boolean {
  return Boolean((process.env.META_SYSTEM_USER_TOKEN || "").trim());
}
export function metaCatalogId(): string {
  return (process.env.META_CATALOG_ID || "").trim() || "924408371841555";
}
function adAccount(): string {
  const a = (process.env.META_AD_ACCOUNT_ID || "").trim() || "act_1237425776744766";
  return a.startsWith("act_") ? a : `act_${a}`;
}

async function graph<T>(path: string, method: "GET" | "POST" = "GET", body?: Record<string, string>): Promise<T> {
  const token = (process.env.META_SYSTEM_USER_TOKEN || "").trim();
  const url = `${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
  for (let a = 0; a < 4; a++) {
    const res = await fetch(url, {
      method,
      body: body ? new URLSearchParams(body) : undefined,
      cache: "no-store",
    });
    const j = (await res.json()) as T & { error?: { message?: string; code?: number } };
    if (j.error) {
      // 4 / 17 / 613 = rate limits — back off and retry.
      if ([4, 17, 32, 613].includes(j.error.code ?? 0)) {
        await new Promise((r) => setTimeout(r, 15000 * (a + 1)));
        continue;
      }
      throw new Error(`Meta: ${j.error.message}`);
    }
    return j;
  }
  throw new Error("Meta: rate limited");
}

export async function catalogProductCount(): Promise<number> {
  const r = await graph<{ product_count?: number }>(`${metaCatalogId()}?fields=product_count`);
  return r.product_count ?? 0;
}

export async function listProductSets(): Promise<Array<{ id: string; name: string; product_count: number }>> {
  const r = await graph<{ data?: Array<{ id: string; name: string; product_count?: number }> }>(
    `${metaCatalogId()}/product_sets?fields=id,name,product_count&limit=200`,
  );
  return (r.data || []).map((s) => ({ id: s.id, name: s.name, product_count: s.product_count ?? 0 }));
}

/** Create or update a product set's filter. Returns its id. */
export async function upsertProductSet(
  existingId: string | null,
  name: string,
  filter: unknown,
): Promise<string> {
  if (existingId) {
    await graph(existingId, "POST", { name, filter: JSON.stringify(filter) });
    return existingId;
  }
  const r = await graph<{ id: string }>(`${metaCatalogId()}/product_sets`, "POST", {
    name,
    filter: JSON.stringify(filter),
  });
  return r.id;
}

export async function productSetCount(id: string): Promise<number> {
  const r = await graph<{ product_count?: number }>(`${id}?fields=product_count`);
  return r.product_count ?? 0;
}

export type SetUse = { productSetId: string; adSet: string; campaign: string; status: string };

/** Ad sets (any campaign, any status except deleted) that advertise a product set. */
export async function metaProductSetUse(): Promise<SetUse[]> {
  const out: SetUse[] = [];
  let path: string | null =
    `${adAccount()}/adsets?fields=name,effective_status,promoted_object,campaign{name}&limit=200`;
  for (let page = 0; path && page < 10; page++) {
    const r: {
      data?: Array<{
        name: string;
        effective_status: string;
        promoted_object?: { product_set_id?: string };
        campaign?: { name?: string };
      }>;
      paging?: { next?: string; cursors?: { after?: string } };
    } = await graph(path);
    for (const a of r.data || []) {
      if (a.promoted_object?.product_set_id) {
        out.push({
          productSetId: a.promoted_object.product_set_id,
          adSet: a.name,
          campaign: a.campaign?.name || "",
          status: a.effective_status,
        });
      }
    }
    path = r.paging?.next && r.paging.cursors?.after
      ? `${adAccount()}/adsets?fields=name,effective_status,promoted_object,campaign{name}&limit=200&after=${r.paging.cursors.after}`
      : null;
  }
  return out;
}
