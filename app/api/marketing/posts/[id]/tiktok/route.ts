import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/marketing/posts/[id]/tiktok — post this Social post to TikTok now,
 * with the choices TikTok's posting rules make the person pick each time
 * (privacy, comments / Duet / Stitch, content disclosure). The caption and
 * hashtags come from the panel as they are on screen.
 * GET — where TikTok is with it (the panel asks every few seconds).
 *
 * The result is kept on the post's TikTok row. A manual post is never retried
 * by the calendar's scheduler (attempts are maxed when it fails).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listPosts } from "@/lib/server/marketing/store";
import { startTikTokPost, tiktokPostStatus } from "@/lib/server/marketing/tiktok";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

const schema = z
  .object({
    caption: z.string().max(2200),
    hashtags: z.array(z.string().max(100)).max(30),
    privacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]),
    allowComment: z.boolean(),
    allowDuet: z.boolean(),
    allowStitch: z.boolean(),
    yourBrand: z.boolean(),
    brandedContent: z.boolean(),
  })
  .strict();

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose who can see it first" }, { status: 400 });
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  if (!post) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  if (!post.media.length) return NextResponse.json({ error: "Add a picture or a video first" }, { status: 400 });
  const busy = post.targets.find((t) => t.provider === "tiktok");
  if (busy?.status === "publishing") return NextResponse.json({ error: "TikTok is still working on this post" }, { status: 409 });
  if (busy?.status === "published") return NextResponse.json({ error: "Already posted to TikTok" }, { status: 409 });
  const b = parsed.data;
  try {
    const { publishId, creator } = await startTikTokPost(g.pool, g.session.tid, post.format, b.caption, b.hashtags, post.media, {
      privacy: b.privacy, allowComment: b.allowComment, allowDuet: b.allowDuet, allowStitch: b.allowStitch, yourBrand: b.yourBrand, brandedContent: b.brandedContent,
    });
    // remote_id holds "publish id|username" until TikTok finishes.
    await g.pool.query(
      `INSERT INTO marketing_post_targets (post_id, provider, status, remote_id, attempts, error, updated_at)
       VALUES ($1::uuid, 'tiktok', 'publishing', $2, 99, NULL, now())
       ON CONFLICT (post_id, provider) DO UPDATE SET status = 'publishing', remote_id = $2, attempts = 99, error = NULL, updated_at = now()`,
      [id, `${publishId}|${creator.username}`],
    );
    return NextResponse.json({ state: "processing" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "TikTok did not take the post" }, { status: 502 });
  }
}

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  const r = await g.pool.query<{ status: string; remote_id: string | null; permalink: string | null; error: string | null; format: string }>(
    `SELECT t.status, t.remote_id, t.permalink, t.error, p.format FROM marketing_post_targets t JOIN marketing_posts p ON p.id = t.post_id
      WHERE t.post_id = $1::uuid AND t.provider = 'tiktok' AND p.tenant_id = $2::uuid`,
    [id, g.session.tid],
  );
  const row = r.rows[0];
  if (!row) return NextResponse.json({ state: "none" });
  if (row.status !== "publishing" || !row.remote_id?.includes("|"))
    return NextResponse.json({ state: row.status === "published" ? "published" : row.status === "failed" ? "failed" : "none", permalink: row.permalink, error: row.error });
  const [publishId, username] = row.remote_id.split("|");
  try {
    const s = await tiktokPostStatus(g.pool, g.session.tid, publishId, row.format, username);
    if (s.state === "published")
      await g.pool.query(
        `UPDATE marketing_post_targets SET status = 'published', remote_id = $2, permalink = $3, published_at = now(), updated_at = now() WHERE post_id = $1::uuid AND provider = 'tiktok'`,
        [id, s.remoteId, s.permalink],
      );
    if (s.state === "failed")
      await g.pool.query(`UPDATE marketing_post_targets SET status = 'failed', error = $2, updated_at = now() WHERE post_id = $1::uuid AND provider = 'tiktok'`, [id, s.error]);
    return NextResponse.json({ state: s.state, permalink: s.permalink, error: s.error });
  } catch (e) {
    return NextResponse.json({ state: "processing", error: e instanceof Error ? e.message : null });
  }
}

export const POST = withActivity("marketing/posts/[id]/tiktok", POST_handler);
