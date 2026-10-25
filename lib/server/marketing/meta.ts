/**
 * Social → Meta: publish to an Instagram business account (single
 * image, carousel, Reel; with Instagram Shop product tags) and to a Facebook
 * page. Uses the system-user token (META_SYSTEM_USER_TOKEN), which carries
 * instagram_content_publish, instagram_shopping_tag_products and
 * pages_manage_posts.
 */

const GRAPH = "https://graph.facebook.com/v21.0";

export function metaPublishConfigured(): boolean {
  return Boolean(process.env.META_SYSTEM_USER_TOKEN?.trim());
}

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } };

export class MetaPublishError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

async function graph<T>(path: string, method: "GET" | "POST", params: Record<string, unknown> = {}, token?: string): Promise<T> {
  const tok = token ?? process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (!tok) throw new MetaPublishError("META_SYSTEM_USER_TOKEN is not set");
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    if (method === "GET") {
      const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), access_token: tok });
      res = await fetch(`${GRAPH}/${path}?${q}`, { signal: AbortSignal.timeout(60_000) });
    } else {
      const body = new URLSearchParams({ access_token: tok });
      for (const [k, v] of Object.entries(params)) {
        if (v === undefined || v === null) continue;
        body.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      res = await fetch(`${GRAPH}/${path}`, { method: "POST", body, signal: AbortSignal.timeout(120_000) });
    }
    const json = (await res.json().catch(() => ({}))) as T & GraphError;
    if (res.ok && !json.error) return json;
    const code = json.error?.code;
    // Rate limits: wait and retry a few times.
    if ([4, 17, 32, 613].includes(code ?? -1) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 20_000 * (attempt + 1)));
      continue;
    }
    throw new MetaPublishError(json.error?.error_user_msg || json.error?.message || `HTTP ${res.status}`, code);
  }
}

export type MetaAccount = { pageId: string; pageName: string; igUserId: string | null; igUsername: string | null };

/** The Facebook pages this token manages and the Instagram account linked to each. */
export async function discoverMetaAccounts(): Promise<MetaAccount[]> {
  const r = await graph<{ data: { id: string; name: string; instagram_business_account?: { id: string; username?: string } }[] }>(
    "me/accounts",
    "GET",
    { fields: "id,name,instagram_business_account{id,username}", limit: 50 },
  );
  return r.data.map((p) => ({
    pageId: p.id,
    pageName: p.name,
    igUserId: p.instagram_business_account?.id ?? null,
    igUsername: p.instagram_business_account?.username ?? null,
  }));
}

export type ProductTag = { productId: string; x: number; y: number };
export type MediaItem = { kind: "image" | "video"; url: string; coverUrl?: string | null; tags: ProductTag[] };

const tagParam = (tags: ProductTag[]) =>
  tags.length ? tags.slice(0, 5).map((t) => ({ product_id: t.productId, x: clamp01(t.x), y: clamp01(t.y) })) : undefined;
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number(n) || 0.5));

/** Video containers process asynchronously; wait until Instagram says FINISHED. */
async function waitForContainer(id: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const s = await graph<{ status_code?: string; status?: string }>(id, "GET", { fields: "status_code,status" });
    if (s.status_code === "FINISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new MetaPublishError(`Instagram could not process the video (${s.status ?? s.status_code})`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  throw new MetaPublishError("Instagram took too long to process the video");
}

export type PublishResult = { remoteId: string; permalink: string | null };

/** Publish one post to Instagram. Caption already includes the hashtags. */
export async function publishInstagram(igUserId: string, format: string, caption: string, media: MediaItem[]): Promise<PublishResult> {
  if (!media.length) throw new MetaPublishError("The post has no picture or video");
  let creationId: string;
  if (format === "reel") {
    const v = media.find((m) => m.kind === "video");
    if (!v) throw new MetaPublishError("A Reel needs a video");
    const c = await graph<{ id: string }>(`${igUserId}/media`, "POST", {
      media_type: "REELS",
      video_url: v.url,
      cover_url: v.coverUrl ?? undefined,
      caption,
      share_to_feed: true,
      product_tags: tagParam(v.tags),
    });
    await waitForContainer(c.id);
    creationId = c.id;
  } else if (format === "carousel" && media.length > 1) {
    const children: string[] = [];
    for (const m of media.slice(0, 10)) {
      const c = await graph<{ id: string }>(`${igUserId}/media`, "POST",
        m.kind === "video"
          ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: true }
          : { image_url: m.url, is_carousel_item: true, product_tags: tagParam(m.tags) });
      if (m.kind === "video") await waitForContainer(c.id);
      children.push(c.id);
    }
    const c = await graph<{ id: string }>(`${igUserId}/media`, "POST", { media_type: "CAROUSEL", children: children.join(","), caption });
    creationId = c.id;
  } else {
    const m = media[0];
    const c = await graph<{ id: string }>(`${igUserId}/media`, "POST", { image_url: m.url, caption, product_tags: tagParam(m.tags) });
    creationId = c.id;
  }
  const pub = await graph<{ id: string }>(`${igUserId}/media_publish`, "POST", { creation_id: creationId });
  const info = await graph<{ permalink?: string }>(pub.id, "GET", { fields: "permalink" }).catch(() => ({ permalink: undefined }));
  return { remoteId: pub.id, permalink: info.permalink ?? null };
}

async function pageToken(pageId: string): Promise<string> {
  const r = await graph<{ access_token?: string }>(pageId, "GET", { fields: "access_token" });
  if (!r.access_token) throw new MetaPublishError("No page token for this Facebook page");
  return r.access_token;
}

/** Publish one post to a Facebook page. Facebook links are clickable, so the shop link goes in the text. */
export async function publishFacebook(pageId: string, format: string, message: string, media: MediaItem[], link: string | null): Promise<PublishResult> {
  const tok = await pageToken(pageId);
  const text = link ? `${message}\n\n${link}` : message;
  let id: string;
  const video = media.find((m) => m.kind === "video");
  if (format === "reel" && video) {
    const r = await graph<{ id: string }>(`${pageId}/videos`, "POST", { file_url: video.url, description: text }, tok);
    id = r.id;
  } else if (media.length > 1) {
    const ids: string[] = [];
    for (const m of media.filter((x) => x.kind === "image").slice(0, 10)) {
      const p = await graph<{ id: string }>(`${pageId}/photos`, "POST", { url: m.url, published: false }, tok);
      ids.push(p.id);
    }
    const r = await graph<{ id: string }>(`${pageId}/feed`, "POST", { message: text, attached_media: ids.map((x) => ({ media_fbid: x })) }, tok);
    id = r.id;
  } else {
    const r = await graph<{ id: string; post_id?: string }>(`${pageId}/photos`, "POST", { url: media[0].url, message: text }, tok);
    id = r.post_id ?? r.id;
  }
  const info = await graph<{ permalink_url?: string }>(id, "GET", { fields: "permalink_url" }, tok).catch(() => ({ permalink_url: undefined }));
  return { remoteId: id, permalink: info.permalink_url ?? null };
}

/**
 * When the Instagram audience is online, per weekday and hour. Instagram gives
 * hourly follower-online counts for recent days in Pacific time; we return the
 * hour in America/New_York.
 */
export async function instagramOnlineFollowers(igUserId: string): Promise<{ weekday: number; hour: number; score: number }[]> {
  const until = Math.floor(Date.now() / 1000);
  const since = until - 29 * 86400;
  const r = await graph<{ data: { values: { value: Record<string, number>; end_time: string }[] }[] }>(`${igUserId}/insights`, "GET", {
    metric: "online_followers",
    period: "lifetime",
    since,
    until,
  });
  const sums = new Map<string, { total: number; n: number }>();
  for (const v of r.data[0]?.values ?? []) {
    // end_time is the start of the NEXT Pacific day, so the counts belong to the day before.
    const ptWeekday = (new Date(new Date(v.end_time).getTime() - 12 * 3600_000).getUTCDay() + 7) % 7;
    for (const [h, count] of Object.entries(v.value ?? {})) {
      const et = Number(h) + 3; // Pacific → Eastern
      const wd = (ptWeekday + Math.floor(et / 24)) % 7;
      const hour = et % 24;
      const k = `${wd}:${hour}`;
      const s = sums.get(k) ?? { total: 0, n: 0 };
      s.total += count;
      s.n += 1;
      sums.set(k, s);
    }
  }
  return [...sums.entries()].map(([k, s]) => {
    const [weekday, hour] = k.split(":").map(Number);
    return { weekday, hour, score: s.total / s.n };
  });
}

export type CatalogProduct = { id: string; name: string; color: string | null; availability: string; visibility: string; groupId: string | null };

/**
 * Products of the Meta catalog (META_CATALOG_ID) whose name contains `name` —
 * the ids Instagram product tags take. Used when "Ask for changes" adds a tag.
 */
export async function searchCatalogProducts(name: string): Promise<CatalogProduct[]> {
  const catalog = process.env.META_CATALOG_ID?.trim();
  if (!catalog) throw new MetaPublishError("META_CATALOG_ID is not set");
  const j = await graph<{ data?: { id: string; name?: string; color?: string; availability?: string; visibility?: string; retailer_product_group_id?: string }[] }>(
    `${catalog}/products`,
    "GET",
    { filter: JSON.stringify({ name: { i_contains: name } }), fields: "id,name,color,availability,visibility,retailer_product_group_id", limit: 100 },
  );
  return (j.data ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? "",
    color: p.color ?? null,
    availability: p.availability ?? "",
    visibility: p.visibility ?? "",
    groupId: p.retailer_product_group_id ?? null,
  }));
}
