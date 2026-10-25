/**
 * Social scheduler, run from the worker loop once a minute.
 *
 * A post goes out only when ALL of these are true:
 *   - the tenant's publish switch is on (marketing_settings.publish_enabled),
 *   - a person approved this post (status 'approved' and approved_by set),
 *   - its scheduled time has passed (and is less than 6 hours ago, so a post
 *     that was missed while the switch was off never goes out late by surprise).
 * Each channel is a separate target; a failure on one does not block the others.
 */
import type { Pool } from "pg";
import { fullCaption, listPosts, type MarketingPost } from "./store";
import { fbPostMetrics, igAccountDay, igMediaMetrics, metaPublishConfigured, publishFacebook, publishInstagram, type MediaItem } from "./meta";

const TICK_MS = 60_000;
const RESULTS_EVERY_MS = 3 * 3600_000;
let lastResults = 0;
const LATE_LIMIT_MS = 6 * 3600_000;
const MAX_ATTEMPTS = 3;
let lastTick = 0;
let running = false;

export async function maybeRunMarketing(pool: Pool): Promise<void> {
  const now = Date.now();
  if (running || now - lastTick < TICK_MS) return;
  lastTick = now;
  running = true;
  try {
    await runDuePosts(pool);
    if (now - lastResults >= RESULTS_EVERY_MS) {
      lastResults = now;
      const r = await refreshResults(pool);
      console.log(`[worker] social results: ${r.posts} post(s), ${r.days} account day(s)${r.errors ? `, ${r.errors} error(s)` : ""}`);
    }
  } catch (e) {
    console.error("[worker] marketing tick failed", e);
  } finally {
    running = false;
  }
}

export async function runDuePosts(pool: Pool): Promise<{ published: number; failed: number }> {
  if (!metaPublishConfigured()) return { published: 0, failed: 0 };
  // Claim due posts atomically so two workers never publish the same post.
  const claimed = await pool.query<{ id: string; tenant_id: string }>(
    `UPDATE marketing_posts p SET status = 'publishing', updated_at = now()
      WHERE p.id IN (
        SELECT p2.id FROM marketing_posts p2
          JOIN marketing_settings s ON s.tenant_id = p2.tenant_id AND s.publish_enabled
         WHERE p2.status = 'approved' AND p2.approved_by IS NOT NULL
           AND p2.scheduled_at <= now() AND p2.scheduled_at > now() - $1::interval
         ORDER BY p2.scheduled_at LIMIT 3
         FOR UPDATE SKIP LOCKED)
      RETURNING p.id, p.tenant_id`,
    [`${LATE_LIMIT_MS / 1000} seconds`],
  );
  let published = 0;
  let failed = 0;
  for (const c of claimed.rows) {
    const [post] = await listPosts(pool, c.tenant_id, { ids: [c.id] });
    if (!post) continue;
    const ok = await publishPost(pool, c.tenant_id, post);
    if (ok) published++;
    else failed++;
  }
  return { published, failed };
}

async function channel(pool: Pool, tenantId: string, provider: string): Promise<string | null> {
  const r = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = $2 AND status = 'connected' ORDER BY connected_at LIMIT 1`,
    [tenantId, provider],
  );
  return r.rows[0]?.account_id ?? null;
}

async function publishPost(pool: Pool, tenantId: string, post: MarketingPost): Promise<boolean> {
  const media: MediaItem[] = post.media.map((m) => ({
    kind: m.kind,
    url: m.url,
    coverUrl: m.coverUrl,
    tags: post.tags.filter((t) => t.mediaPosition === m.position).map((t) => ({ productId: t.metaProductId, x: t.x, y: t.y })),
  }));
  const caption = fullCaption(post);
  for (const t of post.targets) {
    if (t.status === "published" || t.status === "skipped") continue;
    if (t.attempts >= MAX_ATTEMPTS) continue;
    await pool.query(
      `UPDATE marketing_post_targets SET status = 'publishing', attempts = attempts + 1, updated_at = now() WHERE post_id = $1::uuid AND provider = $2`,
      [post.id, t.provider],
    );
    try {
      const account = await channel(pool, tenantId, t.provider);
      if (!account) throw new Error(`No connected ${t.provider} account`);
      const res =
        t.provider === "instagram"
          ? await publishInstagram(account, post.format, caption, media)
          : t.provider === "facebook"
            ? await publishFacebook(account, post.format, caption, media, post.linkUrl)
            : (() => {
                throw new Error(`${t.provider} publishing is not built yet`);
              })();
      await pool.query(
        `UPDATE marketing_post_targets SET status = 'published', remote_id = $3, permalink = $4, error = NULL, published_at = now(), updated_at = now()
          WHERE post_id = $1::uuid AND provider = $2`,
        [post.id, t.provider, res.remoteId, res.permalink],
      );
      await pool.query(`UPDATE marketing_channels SET last_ok_at = now(), last_error = NULL WHERE tenant_id = $1::uuid AND provider = $2`, [tenantId, t.provider]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await pool.query(
        `UPDATE marketing_post_targets SET status = 'failed', error = $3, updated_at = now() WHERE post_id = $1::uuid AND provider = $2`,
        [post.id, t.provider, msg.slice(0, 1000)],
      );
      await pool.query(`UPDATE marketing_channels SET last_error = $3 WHERE tenant_id = $1::uuid AND provider = $2`, [tenantId, t.provider, msg.slice(0, 500)]);
      console.error(`[marketing] ${post.id} → ${t.provider}: ${msg}`);
    }
  }
  const after = await pool.query<{ status: string; attempts: number }>(`SELECT status, attempts FROM marketing_post_targets WHERE post_id = $1::uuid`, [post.id]);
  const done = after.rows.filter((r) => r.status === "published" || r.status === "skipped").length;
  const retryable = after.rows.some((r) => r.status === "failed" && r.attempts < MAX_ATTEMPTS);
  const status = done === after.rows.length ? "published" : retryable ? "approved" : done > 0 ? "partly_published" : "failed";
  await pool.query(`UPDATE marketing_posts SET status = $2, updated_at = now() WHERE id = $1::uuid`, [post.id, status]);
  return status === "published";
}

/** Start of a calendar day in New York, as Unix seconds. */
function etDayStart(daysAgo: number): { sec: number; day: string } {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() - daysAgo * 86_400_000),
  );
  for (const off of ["-04:00", "-05:00"]) {
    const d = new Date(`${day}T00:00:00${off}`);
    const back = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).format(d);
    if (back.startsWith(day) && back.endsWith("00")) return { sec: Math.floor(d.getTime() / 1000), day };
  }
  return { sec: Math.floor(new Date(`${day}T05:00:00Z`).getTime() / 1000), day };
}

/**
 * Results (owner, 2026-10-25): what each post of the last 60 days did on each
 * channel, and the Instagram account's day — followers, reach, views, profile
 * visits, link taps — for yesterday and today so far.
 */
export async function refreshResults(pool: Pool): Promise<{ posts: number; days: number; errors: number }> {
  if (!metaPublishConfigured()) return { posts: 0, days: 0, errors: 0 };
  let posts = 0, days = 0, errors = 0;
  const t = await pool.query<{ id: string; tenant_id: string; provider: string; remote_id: string }>(
    `SELECT g.id, p.tenant_id, g.provider, g.remote_id FROM marketing_post_targets g JOIN marketing_posts p ON p.id = g.post_id
      WHERE g.status = 'published' AND g.remote_id IS NOT NULL AND g.published_at > now() - interval '60 days'`,
  );
  for (const row of t.rows) {
    try {
      let m: Record<string, number>;
      if (row.provider === "instagram") m = await igMediaMetrics(row.remote_id);
      else if (row.provider === "facebook") {
        const page = await channel(pool, row.tenant_id, "facebook");
        if (!page) continue;
        m = await fbPostMetrics(row.remote_id, page);
      } else continue;
      await pool.query(`UPDATE marketing_post_targets SET metrics = $2::jsonb, metrics_at = now() WHERE id = $1::uuid`, [row.id, JSON.stringify(m)]);
      posts++;
    } catch (e) {
      errors++;
      console.error(`[worker] social results for ${row.provider} ${row.remote_id}:`, e instanceof Error ? e.message : e);
    }
  }
  const ig = await pool.query<{ tenant_id: string; account_id: string }>(`SELECT tenant_id, account_id FROM marketing_channels WHERE provider = 'instagram' AND status = 'connected'`);
  for (const a of ig.rows) {
    for (const ago of [1, 0]) {
      try {
        const from = etDayStart(ago);
        const until = ago === 0 ? Math.floor(Date.now() / 1000) : etDayStart(ago - 1).sec;
        const d = await igAccountDay(a.account_id, from.sec, until);
        await pool.query(
          `INSERT INTO marketing_account_stats (tenant_id, provider, account_id, day, followers, reach, views, profile_views, website_clicks, updated_at)
           VALUES ($1::uuid, 'instagram', $2, $3::date, $4, $5, $6, $7, $8, now())
           ON CONFLICT (tenant_id, provider, account_id, day) DO UPDATE SET
             followers = CASE WHEN $9 THEN EXCLUDED.followers ELSE marketing_account_stats.followers END,
             reach = EXCLUDED.reach, views = EXCLUDED.views, profile_views = EXCLUDED.profile_views,
             website_clicks = EXCLUDED.website_clicks, updated_at = now()`,
          [a.tenant_id, a.account_id, from.day, d.followers, d.reach, d.views, d.profile_views, d.website_clicks, ago === 0],
        );
        days++;
      } catch (e) {
        errors++;
        console.error("[worker] social account stats:", e instanceof Error ? e.message : e);
      }
    }
  }
  return { posts, days, errors };
}
