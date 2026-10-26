import type { Pool } from "pg";

/**
 * Every channel Social covers — all of Metricool's networks plus the
 * ad platforms and shopping feeds — in the order the Integrations page shows
 * them. kind: social = organic posting, ads = paid campaigns, shop = product
 * catalogs and shopping feeds.
 */
export const MARKETING_PROVIDERS = [
  { id: "instagram", label: "Instagram", kind: "social", phase: 1 },
  { id: "facebook", label: "Facebook page", kind: "social", phase: 1 },
  { id: "tiktok", label: "TikTok", kind: "social", phase: 2 },
  { id: "youtube", label: "YouTube & Shorts", kind: "social", phase: 2 },
  { id: "pinterest", label: "Pinterest", kind: "social", phase: 2 },
  { id: "snapchat", label: "Snapchat (Public Profile & Spotlight)", kind: "social", phase: 2 },
  { id: "google_business", label: "Google Business Profile", kind: "social", phase: 2 },
  { id: "linkedin", label: "LinkedIn page", kind: "social", phase: 2 },
  { id: "x", label: "X (Twitter)", kind: "social", phase: 2 },
  { id: "threads", label: "Threads", kind: "social", phase: 2 },
  { id: "bluesky", label: "Bluesky", kind: "social", phase: 2 },
  { id: "twitch", label: "Twitch", kind: "social", phase: 3 },
  { id: "meta_ads", label: "Meta Ads (Facebook & Instagram)", kind: "ads", phase: 2 },
  { id: "google_ads", label: "Google Ads (Search, Shopping, PMax, YouTube)", kind: "ads", phase: 2 },
  { id: "tiktok_ads", label: "TikTok Ads", kind: "ads", phase: 3 },
  { id: "snapchat_ads", label: "Snapchat Ads", kind: "ads", phase: 3 },
  { id: "pinterest_ads", label: "Pinterest Ads", kind: "ads", phase: 3 },
  { id: "linkedin_ads", label: "LinkedIn Ads", kind: "ads", phase: 3 },
  { id: "microsoft_ads", label: "Microsoft (Bing) Ads", kind: "ads", phase: 3 },
  { id: "merchant_center", label: "Google Merchant Center", kind: "shop", phase: 2 },
  { id: "meta_catalog", label: "Meta catalog & Instagram Shop", kind: "shop", phase: 2 },
  { id: "tiktok_shop", label: "TikTok Shop catalog", kind: "shop", phase: 3 },
  { id: "pinterest_catalog", label: "Pinterest catalog", kind: "shop", phase: 3 },
  { id: "snapchat_catalog", label: "Snapchat catalog", kind: "shop", phase: 3 },
] as const;
export type MarketingProvider = (typeof MARKETING_PROVIDERS)[number]["id"];
export const PUBLISHABLE: MarketingProvider[] = ["instagram", "facebook", "bluesky", "tiktok"];

/** Where Instagram and Facebook fetch post media (our R2 is private; see /api/public/marketing-media). */
export const PUBLIC_BASE = (process.env.WMS_APP_PUBLIC_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL || "https://wms.shopcarbon.com")
  .trim()
  .replace(/^'|'$/g, "")
  .replace(/\/+$/, "");

export function publicMediaUrl(mediaId: string, kind: "image" | "video", cover = false): string {
  return `${PUBLIC_BASE}/api/public/marketing-media/${mediaId}${cover ? "-cover.jpg" : kind === "video" ? ".mp4" : ".jpg"}`;
}

export type MarketingPost = {
  id: string;
  campaign: string | null;
  sourceRef: string | null;
  title: string;
  format: "image" | "carousel" | "reel" | "story";
  caption: string;
  hashtags: string[];
  linkUrl: string | null;
  scheduledAt: string | null;
  status: string;
  note: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  media: { position: number; kind: "image" | "video"; url: string; coverUrl: string | null }[];
  tags: { mediaPosition: number; metaProductId: string; handle: string | null; label: string; x: number; y: number }[];
  targets: { provider: string; status: string; permalink: string | null; error: string | null; publishedAt: string | null; attempts: number }[];
  /** Ask for changes, carried out by the AI (ai-changes.ts): queued → working → (picture) → done / failed. */
  aiStatus: "queued" | "working" | "picture" | "done" | "failed" | null;
  aiSummary: string | null;
  aiError: string | null;
};

export async function getMarketingSettings(pool: Pool, tenantId: string): Promise<{ publishEnabled: boolean; updatedAt: string | null; updatedBy: string | null }> {
  const r = await pool.query<{ publish_enabled: boolean; updated_at: Date; updated_by: string | null }>(
    `SELECT publish_enabled, updated_at, updated_by FROM marketing_settings WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const row = r.rows[0];
  return { publishEnabled: row?.publish_enabled ?? false, updatedAt: row?.updated_at?.toISOString() ?? null, updatedBy: row?.updated_by ?? null };
}

export async function listPosts(pool: Pool, tenantId: string, opts: { from?: string; to?: string; ids?: string[] } = {}): Promise<MarketingPost[]> {
  const vals: unknown[] = [tenantId];
  let where = "p.tenant_id = $1::uuid";
  if (opts.ids?.length) {
    vals.push(opts.ids);
    where += ` AND p.id = ANY($${vals.length}::uuid[])`;
  } else {
    if (opts.from) {
      vals.push(opts.from);
      where += ` AND (p.scheduled_at IS NULL OR p.scheduled_at >= $${vals.length}::timestamptz)`;
    }
    if (opts.to) {
      vals.push(opts.to);
      where += ` AND (p.scheduled_at IS NULL OR p.scheduled_at < $${vals.length}::timestamptz)`;
    }
  }
  const r = await pool.query(
    `SELECT p.*,
            COALESCE((SELECT json_agg(json_build_object('position', m.position, 'kind', m.kind, 'url', m.url, 'coverUrl', m.cover_url) ORDER BY m.position)
                        FROM marketing_post_media m WHERE m.post_id = p.id), '[]') AS media,
            COALESCE((SELECT json_agg(json_build_object('mediaPosition', t.media_position, 'metaProductId', t.meta_product_id, 'handle', t.shopify_handle,
                                                        'label', t.label, 'x', t.x, 'y', t.y) ORDER BY t.media_position, t.label)
                        FROM marketing_post_tags t WHERE t.post_id = p.id), '[]') AS tags,
            COALESCE((SELECT json_agg(json_build_object('provider', g.provider, 'status', g.status, 'permalink', g.permalink, 'error', g.error,
                                                        'publishedAt', g.published_at, 'attempts', g.attempts) ORDER BY g.provider)
                        FROM marketing_post_targets g WHERE g.post_id = p.id), '[]') AS targets
       FROM marketing_posts p
      WHERE ${where}
      ORDER BY p.scheduled_at NULLS LAST, p.created_at`,
    vals,
  );
  return r.rows.map((p) => ({
    id: p.id,
    campaign: p.campaign,
    sourceRef: p.source_ref,
    title: p.title,
    format: p.format,
    caption: p.caption,
    hashtags: p.hashtags ?? [],
    linkUrl: p.link_url,
    scheduledAt: p.scheduled_at?.toISOString() ?? null,
    status: p.status,
    note: p.note,
    approvedBy: p.approved_by,
    approvedAt: p.approved_at?.toISOString() ?? null,
    media: p.media,
    tags: (p.tags as MarketingPost["tags"]).map((t) => ({ ...t, x: Number(t.x), y: Number(t.y) })),
    targets: p.targets,
    aiStatus: p.ai_status ?? null,
    aiSummary: p.ai_summary ?? null,
    aiError: p.ai_error ?? null,
  }));
}

/** Caption as it goes out: text, a blank line, then the hashtags. */
export function fullCaption(p: Pick<MarketingPost, "caption" | "hashtags">): string {
  const tags = p.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  return tags ? `${p.caption.trim()}\n\n${tags}` : p.caption.trim();
}
