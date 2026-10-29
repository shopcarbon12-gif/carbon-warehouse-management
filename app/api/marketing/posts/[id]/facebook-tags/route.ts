import { withActivity } from "@/lib/server/activity-log";
/**
 * Facebook product tags, done by hand (owner, 2026-10-29). Meta's API tags
 * products on Instagram only, so after a post goes out on Facebook the owner
 * tags the same products there and ticks them done on the post's Facebook card.
 *
 *   GET   → { pageId } — the connected Facebook page (for the Business Suite link)
 *   POST  { done: boolean } — mark the Facebook post as tagged (or not yet)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listPosts } from "@/lib/server/marketing/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const r = await g.pool.query<{ account_id: string }>(
    `SELECT account_id FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'facebook' AND status = 'connected' ORDER BY connected_at LIMIT 1`,
    [g.session.tid],
  );
  return NextResponse.json({ pageId: r.rows[0]?.account_id ?? null });
}

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid post id" }, { status: 400 });
  const b = z.object({ done: z.boolean() }).safeParse(await req.json().catch(() => null));
  if (!b.success) return NextResponse.json({ error: "Send { done: true | false }" }, { status: 400 });
  const r = await g.pool.query(
    `UPDATE marketing_post_targets t
        SET tags_done_at = CASE WHEN $2 THEN now() ELSE NULL END,
            tags_done_by = CASE WHEN $2 THEN $3 ELSE NULL END
       FROM marketing_posts p
      WHERE t.post_id = p.id AND p.id = $1::uuid AND p.tenant_id = $4::uuid AND t.provider = 'facebook' AND t.status = 'published'`,
    [id, b.data.done, g.session.email ?? null, g.session.tid],
  );
  if (!r.rowCount) return NextResponse.json({ error: "This post is not on Facebook yet" }, { status: 409 });
  const [post] = await listPosts(g.pool, g.session.tid, { ids: [id] });
  return NextResponse.json({ post });
}

export const POST = withActivity("marketing/posts/[id]/facebook-tags", POST_handler);
