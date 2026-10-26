import { withActivity } from "@/lib/server/activity-log";
/**
 * Social background AI jobs (lib/server/marketing/ai-jobs.ts).
 *
 * POST { kind: "write", postId, brief } | { kind: "check", postId, caption, hashtags } | { kind: "weekly_review", weekStart? } | { kind: "stories" }
 *   saves the job and answers at once; the server finishes it in the
 *   background, so refreshing or leaving the page loses nothing.
 * GET ?postId=… — the latest write and check job of that post.
 * GET ?kind=weekly_review | stories — the latest job of that kind.
 */
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { enqueueAiJob, runAiJobs, toAiJob } from "@/lib/server/marketing/ai-jobs";
import { claudeConfigured } from "@/lib/server/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

const schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("write"), postId: z.string().uuid(), brief: z.string().max(2000).default("") }).strict(),
  z.object({ kind: z.literal("check"), postId: z.string().uuid(), caption: z.string().min(1).max(2200), hashtags: z.array(z.string().max(100)).max(30) }).strict(),
  z.object({ kind: z.literal("weekly_review"), weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).strict(),
  z.object({ kind: z.literal("stories") }).strict(),
]);

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "What should the AI do?" }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set on the server" }, { status: 503 });
  const b = parsed.data;
  const tid = g.session.tid;
  if ("postId" in b) {
    const p = await g.pool.query(`SELECT 1 FROM marketing_posts WHERE id = $1::uuid AND tenant_id = $2::uuid`, [b.postId, tid]);
    if (!p.rowCount) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  }
  let weekStart = b.kind === "weekly_review" ? b.weekStart : undefined;
  if (b.kind === "weekly_review" && !weekStart) {
    // "Run now": the last full week (Monday to Sunday, Eastern).
    const w = await g.pool.query<{ d: string }>(`SELECT to_char(date_trunc('week', now() AT TIME ZONE 'America/New_York')::date - 7, 'YYYY-MM-DD') AS d`);
    weekStart = w.rows[0].d;
  }
  const job = await enqueueAiJob(g.pool, {
    tenantId: tid,
    postId: "postId" in b ? b.postId : null,
    kind: b.kind,
    input:
      b.kind === "write"
        ? { brief: b.brief }
        : b.kind === "check"
          ? { caption: b.caption, hashtags: b.hashtags.map((h) => h.replace(/^#+/, "")) }
          : b.kind === "stories"
            ? {}
            : { weekStart, manual: true },
    by: g.session.email ?? null,
  });
  const pool = g.pool;
  after(async () => {
    const r = await runAiJobs(pool).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }));
    console.log(`[social-ai-jobs] ${JSON.stringify(r)}`);
  });
  return NextResponse.json({ job }, { status: 202 });
}

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const u = new URL(req.url);
  const postId = u.searchParams.get("postId");
  if (postId) {
    if (!/^[0-9a-f-]{36}$/i.test(postId)) return NextResponse.json({ jobs: [] });
    const r = await g.pool.query(
      `SELECT DISTINCT ON (kind) * FROM marketing_ai_jobs WHERE tenant_id = $1::uuid AND post_id = $2::uuid AND status <> 'dismissed'
        ORDER BY kind, created_at DESC`,
      [g.session.tid, postId],
    );
    return NextResponse.json({ jobs: r.rows.map(toAiJob) });
  }
  const kind = u.searchParams.get("kind");
  if (kind === "weekly_review" || kind === "stories") {
    const r = await g.pool.query(
      `SELECT * FROM marketing_ai_jobs WHERE tenant_id = $1::uuid AND kind = $2 AND status <> 'dismissed' ORDER BY created_at DESC LIMIT 1`,
      [g.session.tid, kind],
    );
    return NextResponse.json({ jobs: r.rows.map(toAiJob) });
  }
  return NextResponse.json({ error: "Which post?" }, { status: 400 });
}

export const POST = withActivity("marketing/ai/jobs", POST_handler);
