import { withActivity } from "@/lib/server/activity-log";
/**
 * PATCH /api/marketing/posts/[id] — edit or decide one post.
 *
 * action: "approve" | "request_changes" | "cancel" | "reopen"
 * caption / hashtags / scheduledAt / targets / tags / title / note: edits.
 *
 * Rules: approval is per post and records who approved it. Any edit to the
 * caption, hashtags, time or channels of an approved post sends it back to
 * draft, so what goes out is always exactly what someone approved. Published
 * posts cannot be edited.
 */
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listPosts, PUBLISHABLE } from "@/lib/server/marketing/store";
import { runMarketingAi } from "@/lib/server/marketing/ai-changes";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

const schema = z
  .object({
    action: z.enum(["approve", "request_changes", "cancel", "reopen"]).optional(),
    caption: z.string().max(2200).optional(),
    hashtags: z.array(z.string().max(100)).max(30).optional(),
    scheduledAt: z.string().datetime({ offset: true }).optional(),
    targets: z.array(z.enum(["instagram", "facebook"])).min(1).optional(),
    note: z.string().max(2000).optional(),
    title: z.string().max(200).optional(),
    /** The full list of Instagram product tags (replaces what is there). */
    tags: z
      .array(
        z.object({
          mediaPosition: z.number().int().min(0).max(9),
          metaProductId: z.string().regex(/^\d+$/),
          handle: z.string().max(200).nullable().optional(),
          label: z.string().max(200),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
        }).strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

async function PATCH_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  const b = parsed.data;
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  if (!post) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  if (["publishing", "published", "partly_published"].includes(post.status))
    return NextResponse.json({ error: "This post has already gone out and cannot be changed" }, { status: 409 });

  let aiQueued = false;
  const client = await g.pool.connect();
  try {
    await client.query("BEGIN");
    const contentEdit =
      b.caption !== undefined || b.hashtags !== undefined || b.scheduledAt !== undefined || b.targets !== undefined || b.tags !== undefined;
    if (b.tags) {
      const per = new Map<number, number>();
      for (const t of b.tags) per.set(t.mediaPosition, (per.get(t.mediaPosition) ?? 0) + 1);
      if ([...per.values()].some((n) => n > 5)) return rollback(client, "Instagram takes at most 5 product tags per picture");
      await client.query(`DELETE FROM marketing_post_tags WHERE post_id = $1::uuid`, [id]);
      for (const t of b.tags)
        await client.query(
          `INSERT INTO marketing_post_tags (post_id, media_position, meta_product_id, shopify_handle, label, x, y) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)`,
          [id, t.mediaPosition, t.metaProductId, t.handle ?? null, t.label, t.x, t.y],
        );
    }
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (b.caption !== undefined) set("caption", b.caption);
    if (b.title !== undefined) set("title", b.title);
    if (b.hashtags !== undefined) set("hashtags", b.hashtags);
    if (b.scheduledAt !== undefined) set("scheduled_at", b.scheduledAt);
    if (b.note !== undefined) set("note", b.note || null);
    if (b.targets !== undefined) {
      await client.query(`DELETE FROM marketing_post_targets WHERE post_id = $1::uuid AND provider <> ALL($2::text[])`, [id, b.targets]);
      for (const t of b.targets.filter((x) => PUBLISHABLE.includes(x)))
        await client.query(`INSERT INTO marketing_post_targets (post_id, provider) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`, [id, t]);
    }
    // An edit after approval needs a fresh approval.
    if (contentEdit && post.status === "approved" && b.action !== "approve") {
      set("status", "draft");
      set("approved_by", null);
      set("approved_at", null);
    }
    if (b.action === "approve") {
      if (post.aiStatus === "queued" || post.aiStatus === "working" || post.aiStatus === "picture")
        return rollback(client, "The AI is still making the changes you asked for — approve it when it is back");
      const when = b.scheduledAt ?? post.scheduledAt;
      const targets = b.targets ?? post.targets.map((t) => t.provider);
      if (!when) return rollback(client, "Pick a date and time first");
      if (!post.media.length) return rollback(client, "This post has no picture or video");
      if (!targets.length) return rollback(client, "Pick at least one channel");
      set("status", "approved");
      set("approved_by", g.session.email ?? g.session.sub);
      sets.push("approved_at = now()");
      await client.query(`UPDATE marketing_post_targets SET status = 'pending', attempts = 0, error = NULL WHERE post_id = $1::uuid AND status = 'failed'`, [id]);
    } else if (b.action === "request_changes") {
      set("status", "changes_requested");
      set("approved_by", null);
      set("approved_at", null);
      // The AI carries out the note (lib/server/marketing/ai-changes.ts) and sends the post back for approval.
      const note = (b.note ?? post.note ?? "").trim();
      if (note) {
        set("ai_status", "queued");
        set("ai_requested_by", g.session.sub);
        set("ai_attempts", 0);
        set("ai_summary", null);
        set("ai_error", null);
        sets.push("ai_requested_at = now()");
        aiQueued = true;
      }
    } else if (b.action === "cancel") {
      set("status", "cancelled");
      set("approved_by", null);
      set("approved_at", null);
    } else if (b.action === "reopen") {
      set("status", "draft");
      set("approved_by", null);
      set("approved_at", null);
    }
    if (sets.length) await client.query(`UPDATE marketing_posts SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, vals);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const [updated] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  if (aiQueued) {
    const pool = g.pool;
    after(async () => {
      await runMarketingAi(pool).catch((e) => console.error("[social-ai] run after request failed", e));
    });
  }
  return NextResponse.json({ post: updated });
}

async function rollback(client: { query: (q: string) => Promise<unknown> }, error: string) {
  await client.query("ROLLBACK").catch(() => {});
  return NextResponse.json({ error }, { status: 400 });
}

export const PATCH = withActivity("marketing/posts/[id]", PATCH_handler);
