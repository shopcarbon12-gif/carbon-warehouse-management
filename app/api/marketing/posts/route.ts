import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/marketing/posts?from=ISO&to=ISO — the calendar: posts with their
 *      pictures, product tags and per-channel results. Admin only.
 * POST /api/marketing/posts — a new post, made in CarbonWMS or the app
 *      (owner, 2026-10-25): a draft with no pictures yet; pictures are added
 *      with POST /api/marketing/posts/<id>/media. Waits for approval like any post.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listPosts } from "@/lib/server/marketing/store";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? undefined;
  const to = url.searchParams.get("to") ?? undefined;
  if ((from && !ISO.test(from)) || (to && !ISO.test(to))) return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  return NextResponse.json({ posts: await listPosts(g.pool, g.session.tid, { from, to }) });
}

const createSchema = z
  .object({
    title: z.string().max(200).default(""),
    format: z.enum(["image", "carousel", "reel", "story"]).default("image"),
    caption: z.string().max(2200).default(""),
    hashtags: z.array(z.string().max(100)).max(30).default([]),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    targets: z.array(z.enum(["instagram", "facebook", "bluesky", "tiktok"])).min(1).default(["instagram", "facebook"]),
  })
  .strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid post" }, { status: 400 });
  const b = parsed.data;
  const r = await g.pool.query<{ id: string }>(
    `INSERT INTO marketing_posts (tenant_id, title, format, caption, hashtags, scheduled_at, status, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, 'draft', $7) RETURNING id`,
    [g.session.tid, b.title, b.format, b.caption, b.hashtags.map((h) => h.replace(/^#+/, "")), b.scheduledAt ?? null, g.session.email ?? null],
  );
  const id = r.rows[0].id;
  for (const t of b.targets) await g.pool.query(`INSERT INTO marketing_post_targets (post_id, provider) VALUES ($1::uuid, $2)`, [id, t]);
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  return NextResponse.json({ post }, { status: 201 });
}

export const POST = withActivity("marketing/posts", POST_handler);
