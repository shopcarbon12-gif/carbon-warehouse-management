/**
 * Radar — reading the library: filters, pattern collections, the seasonal chip, ad detail,
 * Similar ads (embedding cosine; no pgvector on this server), boards and the review queue.
 * Only the admin app reads this — third-party ads are never on public links (spec §11).
 */
import type { Pool } from "pg";
import { appFileUrl } from "../storage";
import { cosine } from "../llm";
import { daysRunning, scoreBreakdown, WINNER_SCORE_EXPLAINED } from "./score";

export type RadarFilters = {
  tab?: "all" | "static" | "video" | "ugc" | "animated" | "bookmarks";
  q?: string;
  sort?: "fresh" | "recommended" | "newest" | "longest";
  category?: string;
  mediaTypes?: string[];
  patterns?: string[];
  lanes?: string[];
  genders?: string[];
  platforms?: string[];
  sources?: string[];
  countries?: string[];
  seasons?: string[];
  brands?: string[];
  daysMin?: number;
  daysMax?: number;
  hasOffer?: boolean;
  aspect?: "vertical" | "square" | "horizontal";
  status?: "kept" | "review" | "rejected";
  limit?: number;
  offset?: number;
};

/** The seasonal chip for today (Eastern). */
export function currentSeason(d = new Date()): { key: string; label: string } {
  const m = d.getMonth() + 1, day = d.getDate();
  if ((m === 11 && day >= 1) || (m === 12 && day <= 2)) return { key: "bfcm", label: "🔥 BFCM" };
  if (m === 12 && day <= 26) return { key: "holiday", label: "🎄 Holiday" };
  if ((m === 12 && day > 26) || (m === 1 && day <= 2)) return { key: "nye", label: "🥂 NYE" };
  if (m === 2 && day <= 15) return { key: "valentines", label: "♥ Valentine's" };
  if (m === 3) return { key: "spring_break", label: "🌴 Spring break" };
  if (m === 4 || (m === 5 && day <= 20)) return { key: "prom", label: "✨ Prom" };
  if (m === 6 || m === 7) return { key: "summer", label: "☀ Summer" };
  if (m === 8 || (m === 9 && day <= 10)) return { key: "back_to_school", label: "🎒 Back to school" };
  return { key: "evergreen", label: "Evergreen" };
}

const arr = (v?: string[]) => (v && v.length ? v : null);

export function aspectOf(media: { w?: number; h?: number }[]): string | null {
  const m = media.find((x) => x.w && x.h);
  if (!m?.w || !m.h) return null;
  const r = m.w / m.h;
  return r < 0.9 ? "vertical" : r > 1.1 ? "horizontal" : "square";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a creative_ads row
function mapCard(r: Record<string, any>) {
  const media = (r.media ?? []) as { kind: string; storage_path: string; poster_path?: string; w?: number; h?: number; duration?: number }[];
  const first = media[0];
  return {
    id: r.id,
    advertiser: r.advertiser,
    headline: r.headline,
    mediaType: r.media_type ?? (first?.kind === "video" ? "video" : media.length > 1 ? "carousel" : "static"),
    thumb: appFileUrl(first?.kind === "video" ? first.poster_path ?? null : first?.storage_path ?? null),
    video: first?.kind === "video" ? appFileUrl(first.storage_path) : null,
    w: first?.w ?? null,
    h: first?.h ?? null,
    platforms: r.platforms,
    sources: r.sources,
    variations: r.variation_count,
    daysRunning: daysRunning(r.first_seen, r.last_seen, r.is_active),
    isActive: r.is_active,
    winnerScore: r.winner_score,
    patterns: r.tags?.creative_pattern ?? [],
    lane: r.tags?.style_lane ?? null,
    hook: r.tags?.hook_text ?? null,
    status: r.status,
    rejectReason: r.reject_reason,
    bookmarked: Boolean(r.bookmarked),
    purged: Boolean(r.media_purged_at),
  };
}
export type RadarCard = ReturnType<typeof mapCard>;

export async function listAds(pool: Pool, tenantId: string, f: RadarFilters) {
  const where: string[] = ["a.tenant_id = $1::uuid"];
  const args: unknown[] = [tenantId];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace(/\$\?/g, `$${args.length}`));
  };
  add("a.status = $?", f.status ?? "kept");
  if (f.tab && f.tab !== "all" && f.tab !== "bookmarks") add("a.media_type = $?", f.tab);
  if (f.tab === "bookmarks") where.push("EXISTS (SELECT 1 FROM creative_board_items bi JOIN creative_boards bo ON bo.id = bi.board_id WHERE bi.ad_id = a.id AND bo.tenant_id = a.tenant_id)");
  if (f.q?.trim()) {
    add("(to_tsvector('simple', a.search_text) @@ plainto_tsquery('simple', $?) OR a.search_text ILIKE '%' || $? || '%')", f.q.trim());
    // second placeholder above reuses the same value
  }
  if (f.category) add("a.category->>'product_category' = $?", f.category);
  if (arr(f.mediaTypes)) add("a.media_type = ANY($?)", f.mediaTypes);
  if (arr(f.patterns)) add("(a.tags->'creative_pattern') ?| $?", f.patterns);
  if (arr(f.lanes)) add("a.tags->>'style_lane' = ANY($?)", f.lanes);
  if (arr(f.genders)) add("a.tags->>'gender' = ANY($?)", f.genders);
  if (arr(f.seasons)) add("a.tags->>'season_event' = ANY($?)", f.seasons);
  if (arr(f.platforms)) add("a.platforms && $?::text[]", f.platforms);
  if (arr(f.sources)) add("a.sources && $?::text[]", f.sources);
  if (arr(f.countries)) add("a.countries && $?::text[]", f.countries);
  if (arr(f.brands)) add("a.brand_id = ANY($?::uuid[])", f.brands);
  if (f.hasOffer) where.push("COALESCE(a.tags->>'offer', '') <> ''");
  const days = "(CASE WHEN a.first_seen IS NULL THEN NULL ELSE (CASE WHEN a.is_active THEN current_date ELSE COALESCE(a.last_seen, current_date) END) - a.first_seen END)";
  if (f.daysMin != null) add(`${days} >= $?`, f.daysMin);
  if (f.daysMax != null) add(`${days} <= $?`, f.daysMax);
  if (f.aspect) {
    const cond = { vertical: "< 0.9", square: "BETWEEN 0.9 AND 1.1", horizontal: "> 1.1" }[f.aspect];
    where.push(`((a.media->0->>'w')::float / NULLIF((a.media->0->>'h')::float, 0)) ${cond}`);
  }
  const order = {
    fresh: `(CASE WHEN a.tags->>'style_lane' IN ('streetwear','denim','luxury','evening_going_out') THEN 1 ELSE 0 END) DESC, (a.first_seen >= current_date - 21) DESC NULLS LAST, a.winner_score DESC NULLS LAST`,
    recommended: "a.winner_score DESC NULLS LAST, a.variation_count DESC",
    newest: "a.first_seen DESC NULLS LAST, a.created_at DESC",
    longest: `${days} DESC NULLS LAST`,
  }[f.sort ?? "fresh"];
  const limit = Math.min(f.limit ?? 60, 200);
  const sqlWhere = where.join(" AND ");
  const [rows, total] = await Promise.all([
    pool.query(
      `SELECT a.*, EXISTS (SELECT 1 FROM creative_board_items bi WHERE bi.ad_id = a.id) AS bookmarked
         FROM creative_ads a WHERE ${sqlWhere} ORDER BY ${order} LIMIT ${limit} OFFSET ${Math.max(0, f.offset ?? 0)}`,
      args,
    ),
    pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM creative_ads a WHERE ${sqlWhere}`, args),
  ]);
  return { ads: rows.rows.map(mapCard), total: total.rows[0].n };
}

export async function radarStats(pool: Pool, tenantId: string) {
  const r = await pool.query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM creative_ads WHERE tenant_id = $1::uuid GROUP BY status`, [tenantId]);
  const by = Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  const tabs = await pool.query<{ media_type: string; n: number }>(`SELECT media_type, COUNT(*)::int AS n FROM creative_ads WHERE tenant_id = $1::uuid AND status = 'kept' GROUP BY media_type`, [tenantId]);
  const reasons = await pool.query<{ reason: string; n: number }>(
    `SELECT split_part(reject_reason, ' (', 1) AS reason, COUNT(*)::int AS n FROM creative_ads WHERE tenant_id = $1::uuid AND status = 'rejected' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
    [tenantId],
  );
  const cats = await pool.query<{ cat: string; n: number }>(
    `SELECT category->>'product_category' AS cat, COUNT(*)::int AS n FROM creative_ads WHERE tenant_id = $1::uuid AND status = 'kept' GROUP BY 1 ORDER BY 2 DESC`,
    [tenantId],
  );
  const brands = await pool.query<{ status: string; n: number }>(`SELECT status, COUNT(*)::int AS n FROM creative_ad_brands WHERE tenant_id = $1::uuid GROUP BY status`, [tenantId]);
  return {
    discovered: Object.values(by).reduce((a: number, b) => a + (b as number), 0),
    new: by.new ?? 0,
    kept: by.kept ?? 0,
    review: by.review ?? 0,
    rejected: by.rejected ?? 0,
    tabs: Object.fromEntries(tabs.rows.map((t) => [t.media_type ?? "untagged", t.n])),
    rejectReasons: reasons.rows,
    categories: cats.rows,
    brands: Object.fromEntries(brands.rows.map((b) => [b.status, b.n])),
    season: currentSeason(),
    scoreExplained: WINNER_SCORE_EXPLAINED,
  };
}

/** Pattern collections carousel: "Material detail as proof · 603 active ads" + a collage. */
export async function patternCollections(pool: Pool, tenantId: string) {
  const r = await pool.query<{ pattern: string; active: number; total: number; thumbs: { kind: string; storage_path: string; poster_path?: string }[][] }>(
    `SELECT p.pattern, COUNT(*) FILTER (WHERE a.is_active)::int AS active, COUNT(*)::int AS total,
            (ARRAY_AGG(a.media ORDER BY a.winner_score DESC NULLS LAST))[1:4] AS thumbs
       FROM creative_ads a, jsonb_array_elements_text(a.tags->'creative_pattern') AS p(pattern)
      WHERE a.tenant_id = $1::uuid AND a.status = 'kept'
      GROUP BY p.pattern ORDER BY active DESC, total DESC LIMIT 24`,
    [tenantId],
  );
  return r.rows.map((x) => ({
    pattern: x.pattern,
    active: x.active,
    total: x.total,
    thumbs: (x.thumbs ?? []).map((m) => {
      const f = m?.[0];
      return appFileUrl(f?.kind === "video" ? f.poster_path ?? null : f?.storage_path ?? null);
    }),
  }));
}

export async function adDetail(pool: Pool, tenantId: string, id: string) {
  const r = await pool.query(`SELECT a.*, EXISTS (SELECT 1 FROM creative_board_items bi WHERE bi.ad_id = a.id) AS bookmarked FROM creative_ads a WHERE a.id = $1::uuid AND a.tenant_id = $2::uuid`, [id, tenantId]);
  const a = r.rows[0];
  if (!a) return null;
  const vars = await pool.query(`SELECT id, source, platform, source_url, headline, body, media, first_seen, last_seen, is_active FROM creative_ad_variations WHERE ad_id = $1::uuid ORDER BY first_seen NULLS LAST`, [id]);
  const dr = daysRunning(a.first_seen, a.last_seen, a.is_active);
  return {
    ...mapCard(a),
    body: a.body,
    cta: a.cta,
    landingUrl: a.landing_url,
    landingShot: appFileUrl(a.landing_shot_path),
    countries: a.countries,
    firstSeen: a.first_seen,
    lastSeen: a.last_seen,
    metrics: a.metrics,
    tags: a.tags,
    category: a.category,
    media: (a.media ?? []).map((m: { kind: string; storage_path: string; poster_path?: string; duration?: number }) => ({ kind: m.kind, url: appFileUrl(m.storage_path), poster: appFileUrl(m.poster_path ?? null), duration: m.duration ?? null })),
    variationsList: vars.rows.map((v) => ({
      id: v.id,
      source: v.source,
      platform: v.platform,
      sourceUrl: v.source_url,
      headline: v.headline,
      firstSeen: v.first_seen,
      lastSeen: v.last_seen,
      isActive: v.is_active,
      thumb: appFileUrl(v.media?.[0]?.kind === "video" ? v.media?.[0]?.poster_path : v.media?.[0]?.storage_path),
    })),
    scoreBreakdown: scoreBreakdown({ daysRunning: dr, variations: a.variation_count, platforms: (a.platforms ?? []).length, active: a.is_active }),
    scoreExplained: WINNER_SCORE_EXPLAINED,
  };
}

export async function similarAds(pool: Pool, tenantId: string, id: string, n = 12) {
  const me = await pool.query<{ embedding: number[] | null; lane: string | null }>(`SELECT embedding, tags->>'style_lane' AS lane FROM creative_ads WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tenantId]);
  const e = me.rows[0]?.embedding;
  if (!e) return [];
  const c = await pool.query(`SELECT a.*, false AS bookmarked FROM creative_ads a WHERE a.tenant_id = $1::uuid AND a.status = 'kept' AND a.id <> $2::uuid AND a.embedding IS NOT NULL ORDER BY a.winner_score DESC NULLS LAST LIMIT 1500`, [tenantId, id]);
  return c.rows
    .map((r) => ({ r, s: cosine(e, r.embedding) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(({ r, s }) => ({ ...mapCard(r), similarity: Math.round(s * 100) / 100 }));
}

/** Top winners in a lane + media type — the Creative Director's research (spec §7.2). */
export async function topWinners(pool: Pool, tenantId: string, opts: { lane?: string | null; mediaType?: string | null; limit?: number }) {
  const r = await pool.query(
    `SELECT id::text, advertiser, tags, winner_score, variation_count, platforms FROM creative_ads
      WHERE tenant_id = $1::uuid AND status = 'kept' AND tags IS NOT NULL
        AND ($2::text IS NULL OR tags->>'style_lane' = $2) AND ($3::text IS NULL OR media_type = $3)
      ORDER BY winner_score DESC NULLS LAST LIMIT $4`,
    [tenantId, opts.lane ?? null, opts.mediaType ?? null, opts.limit ?? 20],
  );
  return r.rows;
}
