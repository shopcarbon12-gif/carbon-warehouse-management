/**
 * POST /api/marketing/ai/write { postId, brief? } — "Write with AI" for the
 * CarbonTools app: title, caption, hashtags and product tags from the
 * pictures. It goes through the background AI jobs (ai-jobs.ts), so it
 * finishes even if the app closes; this answer waits for it up to ~2 minutes.
 * Returns a suggestion; nothing is saved on the post.
 */
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { enqueueAiJob, runAiJobs } from "@/lib/server/marketing/ai-jobs";
import { claudeConfigured } from "@/lib/server/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const schema = z.object({ postId: z.string().uuid(), brief: z.string().max(2000).default("") }).strict();

export async function POST(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Which post?" }, { status: 400 });
  if (!claudeConfigured()) return NextResponse.json({ error: "ANTHROPIC_API_KEY is not set on the server" }, { status: 503 });
  const p = await g.pool.query<{ n: number }>(
    `SELECT (SELECT count(*)::int FROM marketing_post_media m WHERE m.post_id = p.id) AS n FROM marketing_posts p WHERE p.id = $1::uuid AND p.tenant_id = $2::uuid`,
    [parsed.data.postId, g.session.tid],
  );
  if (!p.rows[0]) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  if (!p.rows[0].n) return NextResponse.json({ error: "Add a picture first — the AI writes from the pictures" }, { status: 400 });
  const job = await enqueueAiJob(g.pool, { tenantId: g.session.tid, postId: parsed.data.postId, kind: "write", input: { brief: parsed.data.brief }, by: g.session.email ?? null });
  const pool = g.pool;
  after(() => runAiJobs(pool).then(() => undefined, () => undefined));
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await g.pool.query<{ status: string; result: unknown; error: string | null }>(`SELECT status, result, error FROM marketing_ai_jobs WHERE id = $1::uuid`, [job.id]);
    const row = r.rows[0];
    if (row?.status === "done") return NextResponse.json({ suggestion: row.result, jobId: job.id });
    if (row?.status === "failed") return NextResponse.json({ error: row.error ?? "The AI could not write it" }, { status: 502 });
  }
  return NextResponse.json({ error: "The AI is still writing. Open the post again in a minute; the caption will be waiting.", jobId: job.id }, { status: 202 });
}
