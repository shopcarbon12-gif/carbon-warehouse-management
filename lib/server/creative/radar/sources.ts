/**
 * Radar — source adapters (spec §4). Each one only discovers + normalizes; ingest.ts stores.
 *
 *   meta_api      Meta Ad Library API (ads_archive). Commercial ads only for EU reach, snapshot
 *                 links only → the snapshot page is opened to copy the media.
 *   meta_library  Public Ad Library page (US), read from the page's own JSON.
 *   tiktok_top    TikTok Creative Center Top Ads, industry Apparel & Accessories.
 *   tiktok_dsa    TikTok Ad Library (EU DSA), public page.
 *   google_atc    Google Ads Transparency Center (image + video only).
 *   snap          Snapchat Ads Library API (EU).
 *   pinterest     Pinterest Ads Repository (EU), public page.
 *   manual        The owner pastes a URL or uploads a file.
 * Page scrapers are best effort: platforms change their pages. Each source can be switched off
 * on its own (Settings → Radar) and logs real numbers per run.
 */
import { dateOf, embeddedJson, findObjects, str, withBrowser, type Captured } from "./browser";
import type { AdapterCtx, NormalizedAd, NormalizedMedia, SourceAdapter } from "./ingest";

const MEDIA_RE = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.(?:jpe?g|png|webp|mp4)(?:\?[^"'\s<>\\]*)?/gi;
const unescape = (u: string) => u.replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&");
const brandMatches = (name: string, brand: string) => {
  const a = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = brand.toLowerCase().replace(/[^a-z0-9]/g, "");
  return Boolean(a && b) && (a.includes(b) || b.includes(a));
};

function mediaFromAny(o: unknown, limit = 4): NormalizedMedia[] {
  const s = JSON.stringify(o);
  const urls = [...new Set([...s.matchAll(MEDIA_RE)].map((m) => unescape(m[0])))];
  const vids = urls.filter((u) => /\.mp4/i.test(u)).map((u) => ({ kind: "video" as const, url: u }));
  const imgs = urls.filter((u) => !/\.mp4/i.test(u) && !/(emoji|static\.xx|rsrc\.php|profile|avatar|logo)/i.test(u)).map((u) => ({ kind: "image" as const, url: u }));
  return [...vids, ...imgs].slice(0, limit);
}

/* ------------------------------------------------------------------ Meta: official API (EU) */

export const metaApi: SourceAdapter = {
  key: "meta_api",
  label: "Meta Ad Library API (EU)",
  async *discover(ctx: AdapterCtx) {
    const token = (process.env.META_AD_LIBRARY_TOKEN || process.env.META_SYSTEM_USER_TOKEN || "").trim();
    if (!token) throw new Error("No Meta token (META_AD_LIBRARY_TOKEN). The Ad Library API also needs an identity-verified Meta developer account.");
    const fields = [
      "id", "page_id", "page_name", "ad_creation_time", "ad_delivery_start_time", "ad_delivery_stop_time", "ad_creative_bodies",
      "ad_creative_link_titles", "ad_creative_link_captions", "ad_snapshot_url", "publisher_platforms", "eu_total_reach",
    ].join(",");
    const params = new URLSearchParams({
      access_token: token,
      ad_type: "ALL",
      ad_active_status: "ALL",
      ad_reached_countries: JSON.stringify(ctx.countries.length ? ctx.countries : ["DE", "FR", "IT", "ES", "NL"]),
      fields,
      limit: "50",
    });
    if (ctx.brand?.meta_page_ids?.length) params.set("search_page_ids", JSON.stringify(ctx.brand.meta_page_ids.slice(0, 10)));
    else params.set("search_terms", ctx.keyword ?? ctx.brand?.name ?? "");
    let url: string | null = `https://graph.facebook.com/v21.0/ads_archive?${params}`;
    const rows: Record<string, unknown>[] = [];
    while (url && rows.length < ctx.limit) {
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const j = (await r.json()) as { data?: Record<string, unknown>[]; paging?: { next?: string }; error?: { message?: string } };
      if (j.error) throw new Error(`Meta API: ${j.error.message}`);
      rows.push(...(j.data ?? []));
      url = j.paging?.next ?? null;
    }
    ctx.log(`meta_api: ${rows.length} rows`);
    const picked = rows.slice(0, ctx.limit);
    // Media: open each snapshot page (it has the creative) and copy its pictures / video.
    const media = await withBrowser(async (open) => {
      const out = new Map<string, NormalizedMedia[]>();
      for (const row of picked) {
        const snap = str(row.ad_snapshot_url);
        if (!snap) continue;
        const { html, captured } = await open(snap, { scrolls: 0, waitMs: 2500 });
        out.set(str(row.id), mediaFromAny([html.match(/<(img|video|source)[^>]+>/gi) ?? [], captured.map((c) => c.json)], 4));
      }
      return out;
    });
    for (const row of picked) {
      const name = str(row.page_name);
      yield {
        source: "meta_api",
        externalId: str(row.id),
        platforms: ((row.publisher_platforms as string[]) ?? []).map((p) => p.toLowerCase()),
        advertiser: name,
        headline: ((row.ad_creative_link_titles as string[]) ?? [])[0] ?? "",
        body: ((row.ad_creative_bodies as string[]) ?? [])[0] ?? "",
        cta: null,
        landingUrl: ((row.ad_creative_link_captions as string[]) ?? [])[0] ? `https://${((row.ad_creative_link_captions as string[]) ?? [])[0]}` : null,
        media: media.get(str(row.id)) ?? [],
        firstSeen: dateOf(row.ad_delivery_start_time),
        lastSeen: dateOf(row.ad_delivery_stop_time) ?? new Date().toISOString(),
        isActive: !row.ad_delivery_stop_time,
        countries: ctx.countries,
        metrics: { eu_total_reach: (row.eu_total_reach as number) ?? null },
        sourceUrl: `https://www.facebook.com/ads/library/?id=${str(row.id)}`,
        raw: row,
      } satisfies NormalizedAd;
    }
  },
};

/* ------------------------------------------------------------------ Meta: public library page (US) */

function metaFromObject(o: Record<string, unknown>): NormalizedAd | null {
  const id = str(o.ad_archive_id);
  const snap = (o.snapshot ?? {}) as Record<string, unknown>;
  if (!id || !snap) return null;
  const body = snap.body as Record<string, unknown> | string | undefined;
  const bodyText = typeof body === "string" ? body : str((body as Record<string, unknown>)?.text) || str(((body as Record<string, unknown>)?.markup as Record<string, unknown>)?.__html);
  const media: NormalizedMedia[] = [];
  for (const v of (snap.videos as Record<string, unknown>[]) ?? []) {
    const u = str(v.video_hd_url) || str(v.video_sd_url);
    if (u) media.push({ kind: "video", url: u, poster: str(v.video_preview_image_url) || null });
  }
  for (const im of (snap.images as Record<string, unknown>[]) ?? []) {
    const u = str(im.original_image_url) || str(im.resized_image_url);
    if (u) media.push({ kind: "image", url: u });
  }
  for (const c of (snap.cards as Record<string, unknown>[]) ?? []) {
    const v = str(c.video_hd_url) || str(c.video_sd_url);
    const u = str(c.original_image_url) || str(c.resized_image_url);
    if (v) media.push({ kind: "video", url: v, poster: str(c.video_preview_image_url) || null });
    else if (u) media.push({ kind: "image", url: u });
  }
  const platforms = ((o.publisher_platform as string[]) ?? (o.publisher_platforms as string[]) ?? []).map((p) => String(p).toLowerCase());
  return {
    source: "meta_library",
    externalId: id,
    platforms: platforms.length ? platforms : ["facebook"],
    advertiser: str(snap.page_name) || str(o.page_name),
    headline: str(snap.title) || str(((snap.cards as Record<string, unknown>[]) ?? [])[0]?.title),
    body: bodyText.replace(/<[^>]+>/g, " ").trim(),
    cta: str(snap.cta_text) || null,
    landingUrl: str(snap.link_url) || null,
    media,
    firstSeen: dateOf(o.start_date),
    lastSeen: dateOf(o.end_date) ?? new Date().toISOString(),
    isActive: typeof o.is_active === "boolean" ? o.is_active : null,
    countries: ["US"],
    metrics: { collation_count: (o.collation_count as number) ?? null },
    sourceUrl: `https://www.facebook.com/ads/library/?id=${id}`,
    raw: { ad_archive_id: id, collation_count: o.collation_count ?? null },
  };
}

export const metaLibrary: SourceAdapter = {
  key: "meta_library",
  label: "Meta Ad Library page (US)",
  async *discover(ctx: AdapterCtx) {
    const q = ctx.keyword ?? ctx.brand?.name ?? "";
    const page = ctx.brand?.meta_page_ids?.[0];
    const url = page
      ? `https://www.facebook.com/ads/library/?active_status=all&ad_type=all&country=US&media_type=all&search_type=page&view_all_page_id=${page}`
      : `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&media_type=all&q=${encodeURIComponent(q)}&search_type=keyword_unordered`;
    const found = await withBrowser(async (open) => {
      const { captured, html } = await open(url, { scrolls: Math.ceil(ctx.limit / 10) + 1, matchUrl: /graphql|ads\/library/ });
      const roots = [...captured.map((c: Captured) => c.json), ...embeddedJson(html)];
      return roots.flatMap((r) => findObjects(r, (o) => typeof o.ad_archive_id === "string" && typeof o.snapshot === "object"));
    });
    ctx.log(`meta_library: ${found.length} ad objects on the page`);
    const seen = new Set<string>();
    for (const o of found) {
      const ad = metaFromObject(o);
      if (!ad || seen.has(ad.externalId)) continue;
      seen.add(ad.externalId);
      yield ad;
      if (seen.size >= ctx.limit) break;
    }
  },
};

/* ------------------------------------------------------------------ TikTok Creative Center: Top Ads */

export const tiktokTop: SourceAdapter = {
  key: "tiktok_top",
  label: "TikTok Creative Center — Top Ads",
  async *discover(ctx: AdapterCtx) {
    const industry = process.env.TIKTOK_TOPADS_INDUSTRY || "22000000000"; // Apparel & Accessories
    const kw = ctx.keyword ?? ctx.brand?.name ?? "";
    const url = `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?period=30&region=US&industry=${industry}${kw ? `&keyword=${encodeURIComponent(kw)}` : ""}`;
    const objs = await withBrowser(async (open) => {
      const { captured } = await open(url, { scrolls: 4, matchUrl: /creative_radar_api|top_ads/ });
      return captured.flatMap((c) => findObjects(c.json, (o) => typeof o.ad_title === "string" && (typeof o.video_info === "object" || typeof o.id === "string")));
    });
    ctx.log(`tiktok_top: ${objs.length} ads`);
    for (const o of objs.slice(0, ctx.limit)) {
      const v = (o.video_info ?? {}) as Record<string, unknown>;
      const vu = (v.video_url ?? {}) as Record<string, string>;
      const videoUrl = vu["720p"] || vu["540p"] || vu["480p"] || Object.values(vu)[0] || "";
      yield {
        source: "tiktok_top",
        externalId: str(o.id) || str(o.material_id),
        platforms: ["tiktok"],
        advertiser: str(o.brand_name) || kw || "TikTok advertiser",
        headline: str(o.ad_title),
        body: str(o.ad_title),
        cta: null,
        landingUrl: str(o.landing_page) || null,
        media: videoUrl ? [{ kind: "video", url: videoUrl, poster: str(v.cover) || null }] : mediaFromAny(o, 2),
        firstSeen: null,
        lastSeen: new Date().toISOString(),
        isActive: true,
        countries: ["US"],
        metrics: { ctr: (o.ctr as number) ?? null, likes: (o.like as number) ?? null, cost_level: (o.cost as number) ?? null, objective: str(o.objective_key) || null },
        sourceUrl: `https://ads.tiktok.com/business/creativecenter/topads/${str(o.id)}/pc/en`,
        raw: o,
      };
    }
  },
};

/* ------------------------------------------------------------------ TikTok Ad Library (DSA) */

export const tiktokDsa: SourceAdapter = {
  key: "tiktok_dsa",
  label: "TikTok Ad Library (EU)",
  async *discover(ctx: AdapterCtx) {
    const name = ctx.keyword ?? ctx.brand?.name ?? "";
    const end = Date.now();
    const start = end - 90 * 86_400_000;
    const url = `https://library.tiktok.com/ads?region=all&start_time=${start}&end_time=${end}&adv_name=${encodeURIComponent(name)}&adv_biz_ids=&query_type=1&sort_type=last_shown_date,desc`;
    const objs = await withBrowser(async (open) => {
      const { captured } = await open(url, { scrolls: 3, matchUrl: /api\/v1\/search|ads\/list/ });
      return captured.flatMap((c) => findObjects(c.json, (o) => (typeof o.id === "string" || typeof o.id === "number") && Array.isArray(o.videos)));
    });
    ctx.log(`tiktok_dsa: ${objs.length} ads`);
    for (const o of objs.slice(0, ctx.limit)) {
      const vids = (o.videos as Record<string, unknown>[]).map((v) => ({ kind: "video" as const, url: str(v.video_url), poster: str(v.cover_img) || null })).filter((m) => m.url);
      const adv = str(o.name) || str((o.advertiser as Record<string, unknown>)?.name) || name;
      if (ctx.brand && !brandMatches(adv, ctx.brand.name)) continue;
      yield {
        source: "tiktok_dsa",
        externalId: str(o.id),
        platforms: ["tiktok"],
        advertiser: adv,
        headline: "",
        body: str(o.ad_text) || "",
        media: vids.length ? vids : mediaFromAny(o, 2),
        firstSeen: dateOf(o.first_shown_date),
        lastSeen: dateOf(o.last_shown_date),
        isActive: o.last_shown_date ? Date.now() - (new Date(dateOf(o.last_shown_date) ?? 0).getTime()) < 3 * 86_400_000 : null,
        countries: [],
        metrics: { estimated_audience: str(o.estimated_audience) || null },
        sourceUrl: `https://library.tiktok.com/ads/detail/?ad_id=${str(o.id)}`,
        raw: o,
      };
    }
  },
};

/* ------------------------------------------------------------------ Google Ads Transparency Center */

export const googleAtc: SourceAdapter = {
  key: "google_atc",
  label: "Google Ads Transparency Center",
  async *discover(ctx: AdapterCtx) {
    const adv = ctx.brand?.handles?.google; // AR… advertiser id (Settings → brand)
    if (!adv) {
      ctx.log(`google_atc: no Google advertiser id for ${ctx.brand?.name ?? ctx.keyword} (add it on the brand in Settings → Radar)`);
      return;
    }
    const out: NormalizedAd[] = [];
    await withBrowser(async (open) => {
      for (const format of ["IMAGE", "VIDEO"]) {
        const { captured } = await open(`https://adstransparency.google.com/advertiser/${adv}?region=US&format=${format}`, { scrolls: 3, matchUrl: /SearchService|LookupService/ });
        const text = JSON.stringify(captured.map((c) => c.json));
        const ids = [...new Set([...text.matchAll(/"(CR\d{10,})"/g)].map((m) => m[1]))];
        for (const cr of ids.slice(0, ctx.limit)) {
          const around = text.slice(Math.max(0, text.indexOf(cr) - 200), text.indexOf(cr) + 3000);
          const img = around.match(/https?:\\?\/\\?\/tpc\.googlesyndication\.com\\?\/archive\\?\/simgad\\?\/\d+/)?.[0];
          const yt = around.match(/(?:ytimg\.com\\?\/vi\\?\/|youtube\.com\\?\/watch\?v=)([\w-]{11})/)?.[1];
          const media: NormalizedMedia[] = img ? [{ kind: "image", url: unescape(img) }] : yt ? [{ kind: "image", url: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg` }] : [];
          out.push({
            source: "google_atc",
            externalId: cr,
            platforms: [format === "VIDEO" ? "youtube" : "google"],
            advertiser: ctx.brand?.name ?? "",
            headline: "",
            body: yt ? `YouTube video ${yt}` : "",
            media,
            firstSeen: null,
            lastSeen: new Date().toISOString(),
            isActive: true,
            countries: ["US"],
            sourceUrl: `https://adstransparency.google.com/advertiser/${adv}/creative/${cr}?region=US`,
            raw: { cr, yt: yt ?? null },
          });
        }
      }
    });
    ctx.log(`google_atc: ${out.length} creatives`);
    for (const a of out.slice(0, ctx.limit)) yield a;
  },
};

/* ------------------------------------------------------------------ Snapchat Ads Library API */

export const snap: SourceAdapter = {
  key: "snap",
  label: "Snapchat Ads Library API",
  async *discover(ctx: AdapterCtx) {
    const name = ctx.keyword ?? ctx.brand?.name ?? "";
    const token = (process.env.SNAP_ADS_GALLERY_TOKEN || "").trim();
    const r = await fetch("https://adsapi.snapchat.com/v1/ads_library/ads/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ paying_advertiser_name: name, countries: (ctx.countries.length ? ctx.countries : ["fr", "de"]).map((c) => c.toLowerCase()), limit: Math.min(ctx.limit, 50) }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`Snap Ads Library HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const ads = findObjects(j, (o) => typeof o.id === "string" && ("ad_account_name" in o || "paying_advertiser_name" in o || "creative_type" in o || "top_snap_media_type" in o));
    ctx.log(`snap: ${ads.length} ads`);
    for (const o of ads.slice(0, ctx.limit)) {
      const adv = str(o.paying_advertiser_name) || str(o.ad_account_name) || name;
      if (ctx.brand && !brandMatches(adv, ctx.brand.name)) continue;
      yield {
        source: "snap",
        externalId: str(o.id),
        platforms: ["snapchat"],
        advertiser: adv,
        headline: str(o.headline) || str(o.name),
        body: str(o.brand_name) || "",
        cta: str(o.call_to_action) || null,
        landingUrl: str(o.web_view_url) || str(o.landing_page_url) || null,
        media: mediaFromAny(o, 3),
        firstSeen: dateOf(o.start_date),
        lastSeen: dateOf(o.end_date) ?? new Date().toISOString(),
        isActive: o.status ? str(o.status).toUpperCase() === "ACTIVE" : null,
        countries: ctx.countries,
        metrics: { impressions_total: (o.impressions_total as number) ?? null },
        sourceUrl: null,
        raw: o,
      };
    }
  },
};

/* ------------------------------------------------------------------ Pinterest Ads Repository */

export const pinterest: SourceAdapter = {
  key: "pinterest",
  label: "Pinterest Ads Repository (EU)",
  async *discover(ctx: AdapterCtx) {
    const name = ctx.keyword ?? ctx.brand?.name ?? "";
    const objs = await withBrowser(async (open) => {
      const { captured } = await open(`https://ads.pinterest.com/ads-repository/?query=${encodeURIComponent(name)}&country=FR`, { scrolls: 3, matchUrl: /resource|ads_repository|v5/ });
      return captured.flatMap((c) => findObjects(c.json, (o) => (typeof o.id === "string" || typeof o.pin_id === "string") && JSON.stringify(o).includes("pinimg.com")));
    });
    ctx.log(`pinterest: ${objs.length} ads`);
    let n = 0;
    for (const o of objs) {
      const adv = str(o.advertiser_name) || str((o.advertiser as Record<string, unknown>)?.name) || name;
      if (ctx.brand && !brandMatches(adv, ctx.brand.name)) continue;
      yield {
        source: "pinterest",
        externalId: str(o.id) || str(o.pin_id),
        platforms: ["pinterest"],
        advertiser: adv,
        headline: str(o.title),
        body: str(o.description),
        media: mediaFromAny(o, 2),
        firstSeen: dateOf(o.first_shown_at ?? o.start_date),
        lastSeen: dateOf(o.last_shown_at ?? o.end_date) ?? new Date().toISOString(),
        isActive: null,
        countries: ["FR"],
        sourceUrl: null,
        raw: o,
      };
      if (++n >= ctx.limit) break;
    }
  },
};

export const ADAPTERS: Record<string, SourceAdapter> = {
  meta_api: metaApi,
  meta_library: metaLibrary,
  tiktok_top: tiktokTop,
  tiktok_dsa: tiktokDsa,
  google_atc: googleAtc,
  snap,
  pinterest,
};
/** Default on/off and nightly order. Meta first (phase 2), the rest from phase 7. */
export const SOURCE_DEFAULTS: Record<string, { enabled: boolean; priority: number; note: string }> = {
  meta_library: { enabled: true, priority: 1, note: "Public page, US ads" },
  meta_api: { enabled: true, priority: 2, note: "Official API — EU ads only, needs a verified Meta developer token" },
  tiktok_top: { enabled: true, priority: 3, note: "Industry: Apparel & Accessories" },
  google_atc: { enabled: true, priority: 4, note: "Needs each brand's Google advertiser id (AR…)" },
  snap: { enabled: true, priority: 5, note: "Official API (EU ads)" },
  tiktok_dsa: { enabled: false, priority: 6, note: "Lower priority" },
  pinterest: { enabled: false, priority: 7, note: "Low priority" },
};

/* ------------------------------------------------------------------ manual import */

export async function manualFromUrl(url: string): Promise<NormalizedAd> {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "follow", headers: { "User-Agent": "Mozilla/5.0 (compatible; CarbonWMS-Radar/1.0)" } });
  if (!r.ok) throw new Error(`That link answered HTTP ${r.status}`);
  const ct = r.headers.get("content-type") ?? "";
  const host = new URL(url).hostname.replace(/^www\./, "");
  if (/^(image|video)\//.test(ct)) {
    return { source: "manual", externalId: url, platforms: ["manual"], advertiser: host, headline: "", body: "", media: [{ kind: ct.startsWith("video") ? "video" : "image", url }], sourceUrl: url, lastSeen: new Date().toISOString() };
  }
  const html = (await r.text()).slice(0, 800_000);
  const meta = (p: string) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${p}["'][^>]+content=["']([^"']+)`, "i"))?.[1] ?? "";
  const media: NormalizedMedia[] = [];
  const v = meta("og:video:secure_url") || meta("og:video");
  if (v) media.push({ kind: "video", url: unescape(v) });
  const img = meta("og:image");
  if (img) media.push({ kind: "image", url: unescape(img) });
  return {
    source: "manual",
    externalId: url,
    platforms: [/instagram/.test(host) ? "instagram" : /facebook/.test(host) ? "facebook" : /tiktok/.test(host) ? "tiktok" : /youtube/.test(host) ? "youtube" : "manual"],
    advertiser: meta("og:site_name") || host,
    headline: meta("og:title"),
    body: meta("og:description"),
    media: media.length ? media : mediaFromAny(html, 2),
    sourceUrl: url,
    lastSeen: new Date().toISOString(),
  };
}
