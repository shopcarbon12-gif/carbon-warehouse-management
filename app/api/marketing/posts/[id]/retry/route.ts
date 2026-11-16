import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/marketing/posts/[id]/retry — "Post the failed channels now" (owner, 2026-11-15).
 * A post that went out on some channels and failed on others (Day 14, 2026-11-09: Facebook yes,
 * Instagram "media is not ready") is posted again right away on the failed channels only.
 * Channels that already published are never posted twice.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { postFailedChannelsNow } from "@/lib/server/marketing/scheduler";

export const dynamic = "force-dynamic";
// Instagram videos and TikTok drafts can take a few minutes to process.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  try {
    const status = await postFailedChannelsNow(g.pool, g.session.tid, id);
    const t = await g.pool.query<{ provider: string; status: string; error: string | null; permalink: string | null }>(
      `SELECT provider, status, error, permalink FROM marketing_post_targets WHERE post_id = $1::uuid ORDER BY provider`,
      [id],
    );
    return NextResponse.json({ status, targets: t.rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not post it again" }, { status: 409 });
  }
}

export const POST = withActivity("marketing/posts/[id]/retry", POST_handler);
