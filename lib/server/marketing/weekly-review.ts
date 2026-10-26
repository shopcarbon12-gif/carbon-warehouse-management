/**
 * Social — the weekly review (owner, 2026-10-26: "do it"; the social skill's
 * weekly review step). Every Monday morning (Eastern) it looks at what went out
 * the week before: each post's reach, saves, shares and comments on Instagram
 * and Facebook, the account's followers, reach, profile visits and link taps,
 * and what is planned for the coming week. Claude names what worked and why,
 * what did not, and what to do next week. The result is kept in
 * marketing_weekly_reviews and shown on the Results page. Nothing in the
 * calendar changes; suggestions are for the owner.
 */
import type { Pool } from "pg";
import { claudeStructured } from "@/lib/server/claude";

export type WeeklyReview = {
  weekStart: string;
  numbers: { posts: number; reach: number; interactions: number; saves: number; shares: number; followersStart: number | null; followersEnd: number | null; profileViews: number; linkTaps: number };
  summary: string;
  worked: { title: string; why: string }[];
  weak: { title: string; why: string }[];
  patterns: string[];
  nextWeek: { action: string; why: string }[];
  postSuggestions: { title: string; suggestion: string }[];
};

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "worked", "weak", "patterns", "next_week", "post_suggestions"],
  properties: {
    summary: { type: "string" },
    worked: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "why"], properties: { title: { type: "string" }, why: { type: "string" } } } },
    weak: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "why"], properties: { title: { type: "string" }, why: { type: "string" } } } },
    patterns: { type: "array", items: { type: "string" } },
    next_week: { type: "array", items: { type: "object", additionalProperties: false, required: ["action", "why"], properties: { action: { type: "string" }, why: { type: "string" } } } },
    post_suggestions: { type: "array", items: { type: "object", additionalProperties: false, required: ["title", "suggestion"], properties: { title: { type: "string" }, suggestion: { type: "string" } } } },
  },
} as const;

const SYSTEM = `You are CARBON's social media manager writing the Monday review for the owner. CARBON is a fashion boutique in Orlando, Florida (store + shopcarbon.com). You get last week's posts with their numbers, the Instagram account's days, and next week's plan.

How to judge:
- Saves and shares count more than likes; comments more than likes; reach shows distribution. Compare posts with each other, by format (single picture, carousel, Reel, Story), day and hour, caption opening and hashtags.
- One week is a small sample. Say "watch" instead of a rule when only one post shows it.
- Base everything on the numbers given. Never invent numbers, posts or causes; when the data cannot explain something, say so.

Fields (plain, short English; post titles exactly as given):
- summary: two or three sentences on the week.
- worked: up to 3 posts that did best, each with why (the number and the likely reason).
- weak: up to 3 that did worst, each with why.
- patterns: up to 4 observations about format, timing, captions or hashtags.
- next_week: up to 4 concrete actions for the coming week, each with why.
- post_suggestions: for posts already planned next week, specific changes worth making (title as given, what to change). Empty when none.`;

type Row = { title: string; format: string; provider: string; published_at: Date; caption: string; hashtags: string[]; metrics: Record<string, number> | null };

export async function runWeeklyReview(pool: Pool, tenantId: string, weekStart: string): Promise<WeeklyReview> {
  const posts = (
    await pool.query<Row>(
      `SELECT p.title, p.format, t.provider, t.published_at, p.caption, p.hashtags, t.metrics
         FROM marketing_post_targets t JOIN marketing_posts p ON p.id = t.post_id
        WHERE p.tenant_id = $1::uuid AND t.status = 'published'
          AND (t.published_at AT TIME ZONE 'America/New_York') >= $2::date
          AND (t.published_at AT TIME ZONE 'America/New_York') < $2::date + 7
        ORDER BY t.published_at`,
      [tenantId, weekStart],
    )
  ).rows;
  const days = (
    await pool.query<{ day: string; followers: number | null; reach: number | null; views: number | null; profile_views: number | null; website_clicks: number | null }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, followers, reach, views, profile_views, website_clicks FROM marketing_account_stats
        WHERE tenant_id = $1::uuid AND provider = 'instagram' AND day >= $2::date - 7 AND day < $2::date + 7 ORDER BY day`,
      [tenantId, weekStart],
    )
  ).rows;
  const next = (
    await pool.query<{ title: string; format: string; status: string; at: string }>(
      `SELECT title, format, status, to_char(scheduled_at AT TIME ZONE 'America/New_York', 'Dy Mon DD HH24:MI') AS at FROM marketing_posts
        WHERE tenant_id = $1::uuid AND status NOT IN ('cancelled', 'published')
          AND scheduled_at >= now() AND scheduled_at < now() + interval '7 days' ORDER BY scheduled_at`,
      [tenantId],
    )
  ).rows;

  const sum = (k: string) => posts.reduce((a, p) => a + (Number(p.metrics?.[k]) || 0), 0);
  const inWeek = days.filter((d) => d.day >= weekStart);
  const followers = inWeek.map((d) => d.followers).filter((v): v is number => v != null);
  const numbers: WeeklyReview["numbers"] = {
    posts: new Set(posts.map((p) => `${p.title}|${p.published_at.toISOString().slice(0, 13)}`)).size,
    reach: sum("reach"),
    interactions: sum("total_interactions") || sum("likes") + sum("comments") + sum("saved") + sum("shares"),
    saves: sum("saved"),
    shares: sum("shares"),
    followersStart: followers[0] ?? null,
    followersEnd: followers.at(-1) ?? null,
    profileViews: inWeek.reduce((a, d) => a + (d.profile_views ?? 0), 0),
    linkTaps: inWeek.reduce((a, d) => a + (d.website_clicks ?? 0), 0),
  };

  const empty: WeeklyReview = { weekStart, numbers, summary: "", worked: [], weak: [], patterns: [], nextWeek: [], postSuggestions: [] };
  if (!posts.length) {
    const review = { ...empty, summary: "Nothing was published this week, so there is nothing to compare yet." };
    await save(pool, tenantId, review);
    return review;
  }

  const fmt = (d: Date) => d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const text = [
    `WEEK STARTING ${weekStart} (Monday, Eastern).`,
    `POSTS PUBLISHED (one line per channel):`,
    ...posts.map((p) =>
      `- "${p.title}" · ${p.format} · ${p.provider} · ${fmt(p.published_at)} ET · numbers ${p.metrics ? JSON.stringify(p.metrics) : "not collected yet"} · opening "${p.caption.split("\n")[0].slice(0, 160)}" · hashtags ${p.hashtags.map((h) => `#${h}`).join(" ") || "none"}`,
    ),
    ``,
    `INSTAGRAM ACCOUNT BY DAY (the week before, then this week):`,
    ...days.map((d) => `- ${d.day}: followers ${d.followers ?? "?"}, reach ${d.reach ?? "?"}, views ${d.views ?? "?"}, profile visits ${d.profile_views ?? "?"}, link taps ${d.website_clicks ?? "?"}`),
    ``,
    `PLANNED FOR THE NEXT 7 DAYS:`,
    ...(next.length ? next.map((n) => `- "${n.title}" · ${n.format} · ${n.at} ET · ${n.status}`) : ["- nothing planned"]),
  ].join("\n");

  const r = await claudeStructured<{ summary: string; worked: WeeklyReview["worked"]; weak: WeeklyReview["weak"]; patterns: string[]; next_week: WeeklyReview["nextWeek"]; post_suggestions: WeeklyReview["postSuggestions"] }>({
    system: SYSTEM,
    content: [{ type: "text", text }],
    schema: SCHEMA as unknown as Record<string, unknown>,
    effort: "high",
  });
  const review: WeeklyReview = {
    ...empty,
    summary: r.summary,
    worked: r.worked.slice(0, 3),
    weak: r.weak.slice(0, 3),
    patterns: r.patterns.slice(0, 4),
    nextWeek: r.next_week.slice(0, 4),
    postSuggestions: r.post_suggestions,
  };
  await save(pool, tenantId, review);
  return review;
}

async function save(pool: Pool, tenantId: string, review: WeeklyReview): Promise<void> {
  await pool.query(
    `INSERT INTO marketing_weekly_reviews (tenant_id, week_start, review) VALUES ($1::uuid, $2::date, $3::jsonb)
     ON CONFLICT (tenant_id, week_start) DO UPDATE SET review = EXCLUDED.review, created_at = now()`,
    [tenantId, review.weekStart, JSON.stringify(review)],
  );
}
