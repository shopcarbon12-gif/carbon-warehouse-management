/**
 * Social — background AI jobs (owner, 2026-10-26: an AI action must never
 * block other work, and must still finish if the page is refreshed).
 *
 * Every AI request (Write with AI, caption check, weekly review, making Stories) is saved in
 * marketing_ai_jobs first. The request that made it starts the work after
 * answering (next/server `after`), and the worker's Social AI tick picks up
 * anything left queued or stuck (a deploy, a crash). The screen reads the
 * result whenever the post is opened. "Ask for changes" has its own queue on
 * the post itself (ai-changes.ts); pictures go through the OpenAI Batch API.
 *
 * The weekly review is queued here too, every Monday from 9 AM Eastern, for the
 * week before.
 */
import type { Pool } from "pg";
import { listPosts } from "./store";
import { writePost } from "./ai-write";
import { checkCaption } from "./caption-check";
import { approveNow } from "./approve";
import { runWeeklyReview } from "./weekly-review";
import { makeStories } from "./stories";
import { sendPush } from "@/lib/server/web-push";

export type AiJobKind = "write" | "check" | "weekly_review" | "stories";
export type AiJob = {
  id: string;
  postId: string | null;
  kind: AiJobKind;
  input: Record<string, unknown>;
  status: "queued" | "working" | "done" | "failed" | "dismissed";
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

const MAX_ATTEMPTS = 3;
const STALE_MINUTES = 10;
/** Monday of this week, Eastern, as a date; the review covers the 7 days before it. */
const THIS_MONDAY_ET = `date_trunc('week', now() AT TIME ZONE 'America/New_York')::date`;

type JobRow = { id: string; post_id: string | null; kind: AiJobKind; input: Record<string, unknown>; status: AiJob["status"]; result: unknown; error: string | null; created_at: Date; updated_at: Date };

export function toAiJob(r: JobRow): AiJob {
  return { id: r.id, postId: r.post_id, kind: r.kind, input: r.input, status: r.status, result: r.result, error: r.error, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() };
}

/** Save a job. The same request already waiting (same post, kind and input) is reused. */
export async function enqueueAiJob(
  pool: Pool,
  j: { tenantId: string; postId: string | null; kind: AiJobKind; input: Record<string, unknown>; by: string | null },
): Promise<AiJob> {
  const same = await pool.query<JobRow>(
    `SELECT * FROM marketing_ai_jobs WHERE tenant_id = $1::uuid AND post_id IS NOT DISTINCT FROM $2::uuid AND kind = $3 AND input = $4::jsonb
       AND status IN ('queued', 'working') ORDER BY created_at DESC LIMIT 1`,
    [j.tenantId, j.postId, j.kind, JSON.stringify(j.input)],
  );
  if (same.rows[0]) return toAiJob(same.rows[0]);
  const r = await pool.query<JobRow>(
    `INSERT INTO marketing_ai_jobs (tenant_id, post_id, kind, input, requested_by) VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5) RETURNING *`,
    [j.tenantId, j.postId, j.kind, JSON.stringify(j.input), j.by],
  );
  return toAiJob(r.rows[0]);
}

/** Tenants with AI jobs to run (queued, stuck, or a weekly review due) — for the worker. */
export async function aiJobsPending(pool: Pool): Promise<{ tenant_id: string; requested_by: string | null }[]> {
  const r = await pool.query<{ tenant_id: string; requested_by: string | null }>(
    `SELECT tenant_id::text, max(requested_by) AS requested_by FROM marketing_ai_jobs
      WHERE status = 'queued' OR (status = 'working' AND updated_at < now() - interval '${STALE_MINUTES} minutes')
      GROUP BY tenant_id
     UNION
     SELECT c.tenant_id::text, NULL FROM marketing_channels c
      WHERE c.provider = 'instagram' AND c.status = 'connected'
        AND (now() AT TIME ZONE 'America/New_York') >= ${THIS_MONDAY_ET} + interval '9 hours'
        AND NOT EXISTS (SELECT 1 FROM marketing_ai_jobs j WHERE j.tenant_id = c.tenant_id AND j.kind = 'weekly_review'
                          AND j.input->>'weekStart' = to_char(${THIS_MONDAY_ET} - 7, 'YYYY-MM-DD'))`,
  );
  const seen = new Set<string>();
  return r.rows.filter((x) => !seen.has(x.tenant_id) && seen.add(x.tenant_id));
}

/** Queue last week's review for every tenant that is due (Monday from 9 AM ET). */
async function queueWeeklyReviews(pool: Pool): Promise<number> {
  const due = await pool.query<{ tenant_id: string; week: string }>(
    `SELECT DISTINCT c.tenant_id::text, to_char(${THIS_MONDAY_ET} - 7, 'YYYY-MM-DD') AS week FROM marketing_channels c
      WHERE c.provider = 'instagram' AND c.status = 'connected'
        AND (now() AT TIME ZONE 'America/New_York') >= ${THIS_MONDAY_ET} + interval '9 hours'
        AND NOT EXISTS (SELECT 1 FROM marketing_ai_jobs j WHERE j.tenant_id = c.tenant_id AND j.kind = 'weekly_review'
                          AND j.input->>'weekStart' = to_char(${THIS_MONDAY_ET} - 7, 'YYYY-MM-DD'))`,
  );
  for (const d of due.rows) await enqueueAiJob(pool, { tenantId: d.tenant_id, postId: null, kind: "weekly_review", input: { weekStart: d.week }, by: null });
  return due.rowCount ?? 0;
}

async function runOne(pool: Pool, tenantId: string, job: JobRow & { requested_by?: string | null }): Promise<unknown> {
  if (job.kind === "stories") return makeStories(pool, tenantId, job.requested_by ?? null);
  if (job.kind === "weekly_review") {
    const week = String(job.input.weekStart ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw new Error("No week given");
    return runWeeklyReview(pool, tenantId, week);
  }
  const [post] = job.post_id ? await listPosts(pool, tenantId, { ids: [job.post_id] }) : [];
  if (!post) throw new Error("The post was deleted");
  if (job.kind === "write") {
    if (!post.media.length) throw new Error("Add a picture first — the AI writes from the pictures");
    return writePost(pool, tenantId, post, String(job.input.brief ?? ""));
  }
  const caption = String(job.input.caption ?? "");
  const hashtags = Array.isArray(job.input.hashtags) ? job.input.hashtags.map(String) : [];
  return checkCaption({ caption, hashtags, format: post.format, channels: post.targets.map((t) => t.provider), campaign: post.campaign, products: [...new Set(post.tags.map((t) => t.label))] });
}

/** One pass: recover stuck jobs, queue due weekly reviews, run up to 4 queued jobs. */
export async function runAiJobs(pool: Pool, log: (m: string) => void = (m) => console.log(`[social-ai-jobs] ${m}`)) {
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('marketing_ai_jobs')) AS ok`);
    if (!got.rows[0]?.ok) return { skipped: "busy" };
    try {
      await pool.query(
        `UPDATE marketing_ai_jobs SET status = CASE WHEN attempts >= $1 THEN 'failed' ELSE 'queued' END,
                error = CASE WHEN attempts >= $1 THEN 'The AI stopped part-way several times.' ELSE error END, updated_at = now()
          WHERE status = 'working' AND updated_at < now() - interval '${STALE_MINUTES} minutes'`,
        [MAX_ATTEMPTS],
      );
      const weekly = await queueWeeklyReviews(pool);
      let done = 0, failed = 0;
      for (;;) {
        const claimed = await pool.query<JobRow & { tenant_id: string; requested_by: string | null }>(
          `UPDATE marketing_ai_jobs j SET status = 'working', attempts = attempts + 1, error = NULL, updated_at = now()
            WHERE j.id IN (SELECT id FROM marketing_ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 4 FOR UPDATE SKIP LOCKED)
            RETURNING j.*`,
        );
        if (!claimed.rows.length) break;
        await Promise.all(
          claimed.rows.map(async (job) => {
            try {
              const result = await runOne(pool, job.tenant_id, job);
              await pool.query(`UPDATE marketing_ai_jobs SET status = 'done', result = $2::jsonb, error = NULL, updated_at = now() WHERE id = $1::uuid`, [job.id, JSON.stringify(result)]);
              done++;
              // Approve pressed before the check finished: approve now if it passed and the caption is still the one checked.
              if (job.kind === "check" && job.input.approveWhenOk && job.post_id && (result as { ok?: boolean })?.ok) {
                const r = await pool.query(
                  `SELECT 1 FROM marketing_posts WHERE id = $1::uuid AND caption = $2 AND status IN ('draft', 'changes_requested')`,
                  [job.post_id, String(job.input.caption ?? "")],
                );
                if (r.rowCount) await approveNow(pool, job.post_id, String(job.input.approvedBy ?? job.requested_by ?? "Social"));
              }
              await notify(pool, job);
            } catch (e) {
              failed++;
              const msg = e instanceof Error ? e.message : String(e);
              log(`${job.kind} ${job.id}: ${msg}`);
              await pool.query(
                `UPDATE marketing_ai_jobs SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'queued' END, error = $2, updated_at = now() WHERE id = $1::uuid`,
                [job.id, msg.slice(0, 1000), MAX_ATTEMPTS],
              );
            }
          }),
        );
      }
      return { weekly, done, failed };
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('marketing_ai_jobs'))`).catch(() => {});
    }
  } finally {
    lock.release();
  }
}

/** An alert when something the owner waits for is ready (the caption check answers on screen; no alert). */
async function notify(pool: Pool, job: JobRow & { tenant_id: string }): Promise<void> {
  if (job.kind === "check") return;
  const title = job.kind === "weekly_review" ? "Social · weekly review is ready" : job.kind === "stories" ? "Social · Stories are ready" : "Social · the AI wrote the caption";
  let body = "Open it to see.";
  let url = job.kind === "stories" ? "/marketing/calendar" : "/marketing/results";
  if (job.kind === "stories") {
    const r = await pool.query<{ result: { created?: number } | null }>(`SELECT result FROM marketing_ai_jobs WHERE id = $1::uuid`, [job.id]);
    body = `${r.rows[0]?.result?.created ?? 0} new Stories wait for approval in the calendar.`;
  }
  if (job.kind === "write" && job.post_id) {
    const p = await pool.query<{ title: string }>(`SELECT title FROM marketing_posts WHERE id = $1::uuid`, [job.post_id]);
    body = `${p.rows[0]?.title ?? "A post"}: check it, then save.`;
    url = `/marketing/calendar?post=${job.post_id}`;
  }
  await sendPush(pool, { kind: "social", title, body, url, tag: `social-${job.id}` }, { tenantId: job.tenant_id });
}
