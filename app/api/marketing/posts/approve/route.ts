import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/marketing/posts/approve — approve on the server (lib/server/marketing/approve.ts).
 *   { ids: [postId…] }                                   — the post's own Approve button
 *   { kind: "story"|"reel"|"post"|"all", from, to }        — "Approve all" for Eastern dates from–to
 * Answers each post's outcome: approved, checking (approves itself when the
 * caption check passes) or blocked with the reason.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { approvePost, approveRange } from "@/lib/server/marketing/approve";
import { listPosts } from "@/lib/server/marketing/store";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const schema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }).strict(),
  z.object({ kind: z.enum(["story", "reel", "post", "all"]), from: z.string().regex(DAY), to: z.string().regex(DAY) }).strict(),
]);

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Give the posts, or a kind and a date range" }, { status: 400 });
  const by = g.session.email ?? g.session.sub;
  const b = parsed.data;
  if ("ids" in b) {
    const posts = await listPosts(g.pool, g.session.tid, { ids: b.ids });
    const outcomes = [];
    for (const p of posts) outcomes.push(await approvePost(g.pool, g.session.tid, p, by));
    return NextResponse.json({ outcomes });
  }
  if (b.from > b.to) return NextResponse.json({ error: "The start date is after the end date" }, { status: 400 });
  return NextResponse.json({ outcomes: await approveRange(g.pool, g.session.tid, b.kind, b.from, b.to, by) });
}

export const POST = withActivity("marketing/posts/approve", POST_handler);
