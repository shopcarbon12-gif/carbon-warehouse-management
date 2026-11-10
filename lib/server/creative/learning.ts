/**
 * CarbonWMS Creative — the learning loop (spec §10). 👍/👎, skips and chat edits on everything;
 * real Instagram / Facebook results from CarbonCast (marketing_post_targets.metrics, refreshed every
 * 3 h); Shopify online sales in the post window (correlation, never proof). Ranks recipes, hooks,
 * models, presets and music moods by real CARBON performance; the Director pitches winners more.
 */
import type { Pool } from "pg";

type PostRow = { post_id: string; recipe_key: string | null; model_ids: string[]; preset: string | null; music_mood: string | null; hook: string | null; published_at: Date | null; metrics: Record<string, number>[] | null };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Engagement per post: saves + shares weigh most, then comments, likes; views / reach as reach. */
function postScore(ms: Record<string, number>[] | null): { score: number | null; reach: number | null; views: number | null; saves: number | null; shares: number | null } {
  if (!ms?.length) return { score: null, reach: null, views: null, saves: null, shares: null };
  let reach = 0, views = 0, saves = 0, shares = 0, likes = 0, comments = 0, any = false;
  for (const m of ms) {
    if (!m) continue;
    any = true;
    reach += num(m.reach) ?? 0;
    views += num(m.views) ?? num(m.plays) ?? num(m.video_views) ?? 0;
    saves += num(m.saved) ?? num(m.saves) ?? 0;
    shares += num(m.shares) ?? 0;
    likes += num(m.likes) ?? num(m.like_count) ?? 0;
    comments += num(m.comments) ?? num(m.comments_count) ?? 0;
  }
  if (!any) return { score: null, reach: null, views: null, saves: null, shares: null };
  const base = Math.max(reach, views, 1);
  return { score: ((saves * 4 + shares * 4 + comments * 2 + likes) / base) * 100, reach: reach || null, views: views || null, saves, shares };
}

export async function refreshResults(pool: Pool, tenantId: string): Promise<number> {
  const r = await pool.query<PostRow & { post_id: string }>(
    `SELECT cp.post_id::text, cp.recipe_key, cp.model_ids, cp.preset, cp.music_mood, cp.hook,
            MIN(t.published_at) AS published_at, ARRAY_AGG(t.metrics) FILTER (WHERE t.metrics IS NOT NULL) AS metrics
       FROM creative_posts cp JOIN marketing_post_targets t ON t.post_id = cp.post_id
      WHERE cp.tenant_id = $1::uuid GROUP BY cp.post_id, cp.recipe_key, cp.model_ids, cp.preset, cp.music_mood, cp.hook`,
    [tenantId],
  );
  let n = 0;
  for (const p of r.rows) {
    const s = postScore(p.metrics);
    let sales: { orders: number; total: number; windowHours: number } | null = null;
    if (p.published_at) {
      const o = await pool.query<{ n: number; total: string }>(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(total), 0) AS total FROM email_orders_seen
          WHERE tenant_id = $1::uuid AND source = 'shopify' AND processed_at >= $2 AND processed_at < $2 + interval '48 hours'`,
        [tenantId, p.published_at],
      ).catch(() => ({ rows: [{ n: 0, total: "0" }] }));
      sales = { orders: o.rows[0].n, total: Number(o.rows[0].total), windowHours: 48 };
    }
    await pool.query(`UPDATE creative_posts SET results = $2::jsonb, sales = $3::jsonb, results_at = now() WHERE post_id = $1::uuid`, [p.post_id, JSON.stringify(s), JSON.stringify(sales)]);
    n++;
  }
  return n;
}

export type Ranking = { dimension: string; key: string; posts: number; avgScore: number };

export async function rankings(pool: Pool, tenantId: string): Promise<Ranking[]> {
  const r = await pool.query<{ recipe_key: string | null; model_ids: string[]; preset: string | null; music_mood: string | null; hook: string | null; score: number | null }>(
    `SELECT recipe_key, model_ids, preset, music_mood, hook, (results->>'score')::float AS score FROM creative_posts WHERE tenant_id = $1::uuid AND results ? 'score' AND results->>'score' IS NOT NULL`,
    [tenantId],
  );
  const acc = new Map<string, { dimension: string; key: string; total: number; n: number }>();
  const add = (dimension: string, key: string | null, s: number) => {
    if (!key) return;
    const k = `${dimension}:${key}`;
    const a = acc.get(k) ?? { dimension, key, total: 0, n: 0 };
    a.total += s;
    a.n++;
    acc.set(k, a);
  };
  for (const p of r.rows) {
    if (p.score == null) continue;
    add("recipe", p.recipe_key, p.score);
    add("preset", p.preset, p.score);
    add("music", p.music_mood, p.score);
    add("hook", p.hook, p.score);
    for (const m of p.model_ids ?? []) add("model", m, p.score);
  }
  // Owner's 👍 / 👎 on finished projects count too (small weight).
  const fb = await pool.query<{ verdict: string; recipe: string | null; preset: string | null }>(
    `SELECT f.verdict, p.concepts->(p.concept_idx)->>'recipe_key' AS recipe, p.preset FROM creative_feedback f JOIN creative_projects p ON p.id::text = f.target_id
      WHERE f.tenant_id = $1::uuid AND f.target = 'project' AND f.verdict IN ('up','down')`,
    [tenantId],
  );
  for (const f of fb.rows) {
    const s = f.verdict === "up" ? 1 : -1;
    add("recipe", f.recipe, s);
    add("preset", f.preset, s);
  }
  return [...acc.values()].map((a) => ({ dimension: a.dimension, key: a.key, posts: a.n, avgScore: Math.round((a.total / a.n) * 100) / 100 })).sort((a, b) => b.avgScore - a.avgScore);
}

/** "What's working for CARBON" — plain sentences, only from real numbers. */
export async function whatsWorking(pool: Pool, tenantId: string): Promise<string[]> {
  const rk = await rankings(pool, tenantId);
  const posted = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM creative_posts WHERE tenant_id = $1::uuid AND results ? 'score'`, [tenantId]);
  if (!posted.rows[0].n) return [];
  const out: string[] = [];
  const top = (d: string) => rk.filter((x) => x.dimension === d && x.posts >= 1);
  const recipes = top("recipe");
  if (recipes.length >= 2) out.push(`"${recipes[0].key.replace(/_/g, " ")}" is your best recipe so far (${recipes[0].posts} post${recipes[0].posts > 1 ? "s" : ""}); "${recipes[recipes.length - 1].key.replace(/_/g, " ")}" is the weakest.`);
  else if (recipes.length) out.push(`Only one recipe has real results yet: "${recipes[0].key.replace(/_/g, " ")}".`);
  const presets = top("preset");
  if (presets.length >= 2) out.push(`The ${presets[0].key} look gets more saves and shares than ${presets[presets.length - 1].key}.`);
  const music = top("music");
  if (music.length >= 2) out.push(`${music[0].key} music beats ${music[music.length - 1].key}.`);
  const models = top("model");
  if (models.length >= 2) out.push(`Posts with model ${models[0].key} do best right now.`);
  out.push(`Based on ${posted.rows[0].n} posted creative${posted.rows[0].n > 1 ? "s" : ""} — sales next to a post are a correlation, not proof.`);
  return out;
}

/** For the Director's brief: short lines about what has really worked. */
export async function ownWinners(pool: Pool, tenantId: string): Promise<string[]> {
  const rk = await rankings(pool, tenantId).catch(() => []);
  return rk
    .filter((x) => x.posts >= 1)
    .slice(0, 6)
    .map((x) => `${x.dimension} "${x.key}" — avg engagement score ${x.avgScore} over ${x.posts} post(s)`);
}

export async function recordFeedback(pool: Pool, tenantId: string, v: { target: string; targetId: string; verdict: "up" | "down" | "skip" | "edit"; note?: string | null; meta?: unknown; by: string | null }) {
  await pool.query(`INSERT INTO creative_feedback (tenant_id, target, target_id, verdict, note, meta, created_by) VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7)`, [
    tenantId, v.target, v.targetId, v.verdict, v.note ?? null, JSON.stringify(v.meta ?? null), v.by,
  ]);
}
