/**
 * CarbonWMS Creative — long work runs as jobs with visible status (spec §13):
 * queued → running → (waiting → running …) → done | failed | paused, each with a plain-English
 * progress line and error. The worker calls /api/creative/tick once a minute while anything is
 * due (the web app holds the keys); a tap in the app also runs a tick straight away.
 */
import type { Pool } from "pg";
import { PlainError } from "./config";

export type JobOutcome =
  | { status: "done"; result?: unknown; progress?: string }
  | { status: "waiting"; afterSeconds: number; progress?: string; payload?: Record<string, unknown> };

export type JobRow = {
  id: string;
  tenant_id: string;
  kind: string;
  project_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  requested_by: string | null;
};

export type JobHandler = (pool: Pool, job: JobRow, setProgress: (p: string) => Promise<void>) => Promise<JobOutcome>;

export async function enqueue(
  pool: Pool,
  tenantId: string,
  kind: string,
  payload: Record<string, unknown>,
  opts: { projectId?: string | null; requestedBy?: string | null; afterSeconds?: number; progress?: string } = {},
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO creative_jobs (tenant_id, kind, project_id, payload, requested_by, run_after, progress)
     VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5, now() + make_interval(secs => $6), $7) RETURNING id`,
    [tenantId, kind, opts.projectId ?? null, JSON.stringify(payload), opts.requestedBy ?? null, opts.afterSeconds ?? 0, opts.progress ?? "Queued"],
  );
  return r.rows[0].id;
}

export async function pendingTenants(pool: Pool): Promise<{ tenant_id: string; requested_by: string | null }[]> {
  const r = await pool.query<{ tenant_id: string; requested_by: string | null }>(
    `SELECT DISTINCT ON (tenant_id) tenant_id::text, requested_by FROM creative_jobs
      WHERE status IN ('queued','waiting') AND run_after <= now()
         OR (status = 'running' AND updated_at < now() - interval '15 minutes')
      ORDER BY tenant_id, created_at`,
  );
  return r.rows;
}

export function plainMessage(e: unknown): string {
  if (e instanceof PlainError) return e.message;
  const m = e instanceof Error ? e.message : String(e);
  if (/rate limit|429/i.test(m)) return "The AI service is busy (rate limit). It will be retried.";
  if (/timeout|timed out|aborted/i.test(m)) return "The AI service took too long to answer. Try again.";
  if (/safety|moderation|blocked/i.test(m)) return "The AI service blocked this (safety filter). Try a different pose, outfit angle or wording.";
  return `Something went wrong: ${m.slice(0, 240)}`;
}

/** Run due jobs for one tenant for at most `budgetMs`. */
export async function tick(pool: Pool, tenantId: string, handlers: Record<string, JobHandler>, budgetMs = 45_000): Promise<{ ran: number }> {
  const start = Date.now();
  let ran = 0;
  // Jobs left 'running' by a restart are picked up again.
  await pool.query(
    `UPDATE creative_jobs SET status = 'queued', progress = 'Restarted after an interruption' WHERE tenant_id = $1::uuid AND status = 'running' AND updated_at < now() - interval '15 minutes'`,
    [tenantId],
  );
  while (Date.now() - start < budgetMs) {
    const c = await pool.query<JobRow>(
      `UPDATE creative_jobs SET status = 'running', attempts = attempts + 1, updated_at = now()
        WHERE id = (SELECT id FROM creative_jobs WHERE tenant_id = $1::uuid AND status IN ('queued','waiting') AND run_after <= now()
                     ORDER BY run_after, created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, tenant_id::text, kind, project_id::text, payload, attempts, requested_by`,
      [tenantId],
    );
    const job = c.rows[0];
    if (!job) break;
    ran++;
    const handler = handlers[job.kind];
    const setProgress = async (p: string) => {
      await pool.query(`UPDATE creative_jobs SET progress = $2, updated_at = now() WHERE id = $1::uuid`, [job.id, p.slice(0, 300)]);
    };
    try {
      if (!handler) throw new Error(`no handler for ${job.kind}`);
      const out = await handler(pool, job, setProgress);
      if (out.status === "done") {
        await pool.query(`UPDATE creative_jobs SET status = 'done', result = $2::jsonb, progress = COALESCE($3, 'Done'), error = NULL, updated_at = now() WHERE id = $1::uuid`, [
          job.id,
          JSON.stringify(out.result ?? null),
          out.progress ?? null,
        ]);
      } else {
        await pool.query(
          `UPDATE creative_jobs SET status = 'waiting', run_after = now() + make_interval(secs => $2), progress = COALESCE($3, progress),
                  payload = COALESCE($4::jsonb, payload), attempts = 0, updated_at = now() WHERE id = $1::uuid`,
          [job.id, out.afterSeconds, out.progress ?? null, out.payload ? JSON.stringify(out.payload) : null],
        );
      }
    } catch (e) {
      const msg = plainMessage(e);
      const paused = msg.startsWith("Paused:");
      const retry = !paused && !(e instanceof PlainError) && job.attempts < 3 && /busy|too long/.test(msg);
      console.error(`[creative] job ${job.kind} ${job.id} failed:`, e);
      await pool.query(
        `UPDATE creative_jobs SET status = $2, error = $3, progress = $4, run_after = now() + interval '2 minutes', updated_at = now() WHERE id = $1::uuid`,
        [job.id, paused ? "paused" : retry ? "queued" : "failed", msg, paused ? "Paused at the spend cap" : retry ? "Will retry" : "Failed"],
      );
      if (job.project_id && !retry) {
        await pool.query(`UPDATE creative_projects SET step_note = $2, updated_at = now() WHERE id = $1::uuid`, [job.project_id, msg]);
      }
    }
  }
  return { ran };
}

export async function listJobs(pool: Pool, tenantId: string, opts: { projectId?: string; limit?: number } = {}) {
  const r = await pool.query(
    `SELECT id, kind, project_id, status, progress, error, created_at, updated_at, result
       FROM creative_jobs WHERE tenant_id = $1::uuid AND ($2::uuid IS NULL OR project_id = $2::uuid)
      ORDER BY created_at DESC LIMIT $3`,
    [tenantId, opts.projectId ?? null, opts.limit ?? 30],
  );
  return r.rows;
}
