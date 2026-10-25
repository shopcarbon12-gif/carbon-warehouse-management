/**
 * Social → Ads (owner, 2026-10-25: Meta Ads and Google Ads control).
 * Every campaign with its status, budget and the last 7 days, read straight
 * from Meta and Google. Changes are pause / resume and a campaign's daily
 * budget, each only on an explicit confirm on the screen (owner's rule: no
 * spend without his OK). Nothing here creates or launches a campaign.
 */
import { googleAdsConfigured, googleAdsSearch, googleAdsUpdate, googleAdsCustomer } from "@/lib/server/google-merchant";

const GRAPH = "https://graph.facebook.com/v21.0";

export type AdCampaign = {
  platform: "meta" | "google";
  id: string;
  name: string;
  status: "active" | "paused" | "other";
  rawStatus: string;
  objective: string | null;
  /** Daily budget in dollars when it is set on the campaign itself (else on its ad sets / shared). */
  dailyBudget: number | null;
  budgetId: string | null;
  spend7: number;
  impressions7: number;
  clicks7: number;
  conversions7: number;
  conversionValue7: number;
};

function metaToken() {
  const t = process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (!t) throw new Error("META_SYSTEM_USER_TOKEN is not set");
  return t;
}
function metaAccount() {
  const a = (process.env.META_AD_ACCOUNT_ID || "").trim();
  if (!a) throw new Error("META_AD_ACCOUNT_ID is not set");
  return a.startsWith("act_") ? a : `act_${a}`;
}

async function metaGet<T>(path: string, q: Record<string, string>): Promise<T> {
  const res = await fetch(`${GRAPH}/${path}?${new URLSearchParams({ ...q, access_token: metaToken() })}`, { cache: "no-store", signal: AbortSignal.timeout(60_000) });
  const j = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok || j.error) throw new Error(`Meta: ${j.error?.message ?? res.status}`);
  return j;
}

async function metaPost(path: string, params: Record<string, string>): Promise<void> {
  const res = await fetch(`${GRAPH}/${path}`, { method: "POST", body: new URLSearchParams({ ...params, access_token: metaToken() }), signal: AbortSignal.timeout(60_000) });
  const j = (await res.json()) as { error?: { message?: string; error_user_msg?: string } };
  if (!res.ok || j.error) throw new Error(`Meta: ${j.error?.error_user_msg ?? j.error?.message ?? res.status}`);
}

const PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"];

export async function metaCampaigns(): Promise<AdCampaign[]> {
  const acct = metaAccount();
  const c = await metaGet<{ data: { id: string; name: string; effective_status: string; status: string; daily_budget?: string; objective?: string }[] }>(
    `${acct}/campaigns`, { fields: "id,name,status,effective_status,daily_budget,objective", limit: "100", filtering: JSON.stringify([{ field: "effective_status", operator: "NOT_IN", value: ["DELETED", "ARCHIVED"] }]) },
  );
  const ins = await metaGet<{ data: { campaign_id: string; spend?: string; impressions?: string; clicks?: string; actions?: { action_type: string; value: string }[]; action_values?: { action_type: string; value: string }[] }[] }>(
    `${acct}/insights`, { level: "campaign", date_preset: "last_7d", fields: "campaign_id,spend,impressions,clicks,actions,action_values", limit: "200" },
  );
  const by = new Map(ins.data.map((i) => [i.campaign_id, i]));
  const pick = (list: { action_type: string; value: string }[] | undefined) => {
    for (const t of PURCHASE) {
      const v = list?.find((a) => a.action_type === t);
      if (v) return Number(v.value) || 0;
    }
    return 0;
  };
  return c.data.map((x) => {
    const i = by.get(x.id);
    return {
      platform: "meta" as const,
      id: x.id,
      name: x.name,
      status: x.effective_status === "ACTIVE" ? "active" : x.status === "PAUSED" || x.effective_status === "PAUSED" ? "paused" : "other",
      rawStatus: x.effective_status,
      objective: x.objective ?? null,
      dailyBudget: x.daily_budget ? Number(x.daily_budget) / 100 : null,
      budgetId: null,
      spend7: Number(i?.spend ?? 0),
      impressions7: Number(i?.impressions ?? 0),
      clicks7: Number(i?.clicks ?? 0),
      conversions7: pick(i?.actions),
      conversionValue7: pick(i?.action_values),
    };
  });
}

export async function googleCampaigns(): Promise<AdCampaign[]> {
  if (!googleAdsConfigured()) return [];
  type Row = {
    campaign: { id: string; name: string; status: string; advertisingChannelType?: string };
    campaignBudget?: { resourceName?: string; amountMicros?: string };
    metrics?: { costMicros?: string; impressions?: string; clicks?: string; conversions?: number; conversionsValue?: number };
  };
  const rows = await googleAdsSearch<Row>(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.resource_name, campaign_budget.amount_micros,
            metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value
       FROM campaign WHERE campaign.status != 'REMOVED' AND segments.date DURING LAST_7_DAYS`,
  );
  // Campaigns with no traffic this week have no row above; read them too.
  const all = await googleAdsSearch<Row>(
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.resource_name, campaign_budget.amount_micros
       FROM campaign WHERE campaign.status != 'REMOVED'`,
  );
  const sums = new Map<string, Row["metrics"]>();
  for (const r of rows) {
    const s = sums.get(r.campaign.id) ?? { costMicros: "0", impressions: "0", clicks: "0", conversions: 0, conversionsValue: 0 };
    s.costMicros = String(Number(s.costMicros) + Number(r.metrics?.costMicros ?? 0));
    s.impressions = String(Number(s.impressions) + Number(r.metrics?.impressions ?? 0));
    s.clicks = String(Number(s.clicks) + Number(r.metrics?.clicks ?? 0));
    s.conversions = (s.conversions ?? 0) + Number(r.metrics?.conversions ?? 0);
    s.conversionsValue = (s.conversionsValue ?? 0) + Number(r.metrics?.conversionsValue ?? 0);
    sums.set(r.campaign.id, s);
  }
  return all.map((r) => {
    const m = sums.get(r.campaign.id);
    return {
      platform: "google" as const,
      id: r.campaign.id,
      name: r.campaign.name,
      status: r.campaign.status === "ENABLED" ? "active" : r.campaign.status === "PAUSED" ? "paused" : "other",
      rawStatus: r.campaign.status,
      objective: r.campaign.advertisingChannelType ?? null,
      dailyBudget: r.campaignBudget?.amountMicros ? Number(r.campaignBudget.amountMicros) / 1e6 : null,
      budgetId: r.campaignBudget?.resourceName ?? null,
      spend7: Number(m?.costMicros ?? 0) / 1e6,
      impressions7: Number(m?.impressions ?? 0),
      clicks7: Number(m?.clicks ?? 0),
      conversions7: Number(m?.conversions ?? 0),
      conversionValue7: Number(m?.conversionsValue ?? 0),
    };
  });
}

/** Pause or resume one campaign. */
export async function setCampaignStatus(platform: "meta" | "google", id: string, active: boolean): Promise<void> {
  if (platform === "meta") return metaPost(id, { status: active ? "ACTIVE" : "PAUSED" });
  await googleAdsUpdate("campaigns", { resourceName: `customers/${googleAdsCustomer()}/campaigns/${id}`, status: active ? "ENABLED" : "PAUSED" }, "status");
}

/** A campaign's daily budget in dollars (Meta: set on the campaign; Google: its campaign budget). */
export async function setCampaignBudget(platform: "meta" | "google", id: string, budgetId: string | null, dollars: number): Promise<void> {
  if (!(dollars >= 1 && dollars <= 1000)) throw new Error("A daily budget between $1 and $1,000");
  if (platform === "meta") return metaPost(id, { daily_budget: String(Math.round(dollars * 100)) });
  if (!budgetId) throw new Error("This Google campaign has no budget of its own");
  await googleAdsUpdate("campaignBudgets", { resourceName: budgetId, amountMicros: String(Math.round(dollars * 1e6)) }, "amount_micros");
}
