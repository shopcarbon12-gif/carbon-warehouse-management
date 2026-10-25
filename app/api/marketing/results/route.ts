/**
 * GET /api/marketing/results — Social results: the Instagram account by day
 * (last 30 days) and every published post with what it did on each channel.
 * Numbers are refreshed by the worker every 3 hours (scheduler.ts).
 * POST — refresh now.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { refreshResults } from "@/lib/server/marketing/scheduler";
import { withActivity } from "@/lib/server/activity-log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const days = await g.pool.query<{ day: string; followers: number | null; reach: number | null; views: number | null; profile_views: number | null; website_clicks: number | null }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, followers, reach, views, profile_views, website_clicks FROM marketing_account_stats
      WHERE tenant_id = $1::uuid AND provider = 'instagram' AND day > current_date - 31 ORDER BY day`,
    [g.session.tid],
  );
  const posts = await g.pool.query<{ id: string; title: string; format: string; thumb: string | null; provider: string; published_at: Date; permalink: string | null; metrics: Record<string, number> | null; metrics_at: Date | null }>(
    `SELECT p.id, p.title, p.format,
            (SELECT COALESCE(CASE WHEN m.kind = 'video' THEN m.cover_url END, m.url) FROM marketing_post_media m WHERE m.post_id = p.id ORDER BY m.position LIMIT 1) AS thumb,
            g.provider, g.published_at, g.permalink, g.metrics, g.metrics_at
       FROM marketing_post_targets g JOIN marketing_posts p ON p.id = g.post_id
      WHERE p.tenant_id = $1::uuid AND g.status = 'published'
      ORDER BY g.published_at DESC LIMIT 200`,
    [g.session.tid],
  );
  return NextResponse.json({
    days: days.rows,
    posts: posts.rows.map((r) => ({ ...r, published_at: r.published_at.toISOString(), metrics_at: r.metrics_at?.toISOString() ?? null })),
  });
}

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  return NextResponse.json(await refreshResults(g.pool));
}

export const POST = withActivity("marketing/results", POST_handler);
