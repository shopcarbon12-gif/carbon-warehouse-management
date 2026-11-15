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

/**
 * `savePayload` writes the job's state right away (e.g. after each paid clip is sent), so a pause / crash /
 * retry mid-step never loses what was already paid for (review 2026-11-15).
 */
export type JobHandler = (pool: Pool, job: JobRow, setProgress: (p: string) => Promise<void>, savePayload: (payload: Record<string, unknown>) => Promise<void>) => Promise<JobOutcome>;

/**
 * The ACTIVE (queued / running / waiting) job of this kind on this project, if any. A paused job is not active: it
 * never blocks new work (review 2026-11-15) — enqueue replaces it.
 */
export async function openJob(pool: Pool, projectId: string, kinds: string[]): Promise<{ id: string; kind: string } | null> {
  const r = await pool.query<{ id: string; kind: string }>(
    `SELECT id::text, kind FROM creative_jobs WHERE project_id = $1::uuid AND kind = ANY($2::text[]) AND status IN ('queued','running','waiting') ORDER BY created_at DESC LIMIT 1`,
    [projectId, kinds],
  );
  return r.rows[0] ?? null;
}

/**
 * A half-price batch reserves its estimate against the cap when sent; this releases it — dated like the
 * reservation, so a release on the next day never lowers that day's total (review 2026-11-15).
 */
export async function releaseReservation(pool: Pool, tenantId: string, payload: Record<string, unknown>, projectId?: string | null): Promise<void> {
  const reserved = Number(payload.reserved ?? 0);
  if (!(reserved > 0)) return;
  await pool.query(
    `INSERT INTO creative_spend (tenant_id, provider, what, cost_usd, estimated, project_id, created_at)
     VALUES ($1::uuid, 'openai', 'batch reservation released', $2, true, $3::uuid, COALESCE($4::timestamptz, now()))`,
    [tenantId, -reserved, projectId ?? null, (payload.reservedAt as string | undefined) ?? null],
  );
}

/** Cancel a project's jobs of these kinds (superseded work), releasing any batch reservation they held. */
export async function cancelJobs(pool: Pool, projectId: string, kinds: string[] | "all", note: string): Promise<void> {
  const r = await pool.query<{ tenant_id: string; payload: Record<string, unknown> }>(
    `UPDATE creative_jobs SET status = 'cancelled', progress = $3, updated_at = now()
      WHERE project_id = $1::uuid AND ($2::text[] IS NULL OR kind = ANY($2::text[])) AND status IN ('queued','waiting','paused','running')
      RETURNING tenant_id::text, payload`,
    [projectId, kinds === "all" ? null : kinds, note],
  );
  for (const j of r.rows) await releaseReservation(pool, j.tenant_id, j.payload, projectId);
}

export async function enqueue(
  pool: Pool,
  tenantId: string,
  kind: string,
  payload: Record<string, unknown>,
  opts: { projectId?: string | null; requestedBy?: string | null; afterSeconds?: number; progress?: string; replace?: boolean } = {},
): Promise<string> {
  // One open job per project + kind: a double tap (or two tabs) never queues — and pays for — the same step twice.
  // The unique partial index creative_jobs_one_open closes the race; a conflict returns the open job.
  // `replace`: this request SUPERSEDES the open one (new concepts, a new pick, a remake) — the old one is cancelled.
  // A paused job of the same kind is always replaced (it must never block new work).
  if (opts.projectId) {
    await pool.query(`UPDATE creative_jobs SET status = 'cancelled', progress = 'Replaced by a newer request', updated_at = now() WHERE project_id = $1::uuid AND kind = $2 AND status = 'paused'`, [opts.projectId, kind]);
    if (opts.replace) await cancelJobs(pool, opts.projectId, [kind], "Replaced by a newer request");
    const open = await openJob(pool, opts.projectId, [kind]);
    if (open) return open.id;
  }
  try {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO creative_jobs (tenant_id, kind, project_id, payload, requested_by, run_after, progress)
       VALUES ($1::uuid, $2, $3::uuid, $4::jsonb, $5, now() + make_interval(secs => $6), $7) RETURNING id`,
      [tenantId, kind, opts.projectId ?? null, JSON.stringify(payload), opts.requestedBy ?? null, opts.afterSeconds ?? 0, opts.progress ?? "Queued"],
    );
    return r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505" && opts.projectId) {
      const open = await openJob(pool, opts.projectId, [kind]);
      if (open) return open.id;
    }
    throw e;
  }
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
    const savePayload = async (payload: Record<string, unknown>) => {
      job.payload = payload;
      await pool.query(`UPDATE creative_jobs SET payload = $2::jsonb, updated_at = now() WHERE id = $1::uuid`, [job.id, JSON.stringify(payload)]);
    };
    if (!handler) {
      // A new kind queued by a migration while the old app is still answering (deploy overlap): try again later —
      // for about an hour, then it fails instead of blocking the project for ever.
      const waits = Number(job.payload?.noHandlerWaits ?? 0);
      if (waits >= 12) await pool.query(`UPDATE creative_jobs SET status = 'failed', error = $2, progress = 'Failed', updated_at = now() WHERE id = $1::uuid`, [job.id, `This step (${job.kind}) isn't available in this version.`]);
      else
        await pool.query(
          `UPDATE creative_jobs SET status = 'queued', attempts = GREATEST(attempts - 1, 0), run_after = now() + interval '5 minutes', progress = 'Waiting for the new version', payload = payload || jsonb_build_object('noHandlerWaits', $2::int), updated_at = now() WHERE id = $1::uuid`,
          [job.id, waits + 1],
        );
      continue;
    }
    try {
      const out = await handler(pool, job, setProgress, savePayload);
      // "AND status = 'running'": a runner that was reset as stale (and re-run elsewhere) can't overwrite the newer run.
      if (out.status === "done") {
        await pool.query(`UPDATE creative_jobs SET status = 'done', result = $2::jsonb, progress = COALESCE($3, 'Done'), error = NULL, updated_at = now() WHERE id = $1::uuid AND status = 'running'`, [
          job.id,
          JSON.stringify(out.result ?? null),
          out.progress ?? null,
        ]);
      } else {
        await pool.query(
          `UPDATE creative_jobs SET status = 'waiting', run_after = now() + make_interval(secs => $2), progress = COALESCE($3, progress),
                  payload = COALESCE($4::jsonb, payload), attempts = 0, updated_at = now() WHERE id = $1::uuid AND status = 'running'`,
          [job.id, out.afterSeconds, out.progress ?? null, out.payload ? JSON.stringify(out.payload) : null],
        );
      }
    } catch (e) {
      const msg = plainMessage(e);
      const paused = msg.startsWith("Paused:");
      const retry = !paused && !(e instanceof PlainError) && job.attempts < 3 && /busy|too long/.test(msg);
      console.error(`[creative] job ${job.kind} ${job.id} failed:`, e);
      // Guarded: a job cancelled meanwhile (Delete, replaced) stays cancelled.
      await pool.query(
        `UPDATE creative_jobs SET status = $2, error = $3, progress = $4, run_after = now() + interval '2 minutes', updated_at = now() WHERE id = $1::uuid AND status = 'running'`,
        [job.id, paused ? "paused" : retry ? "queued" : "failed", msg, paused ? "Paused at the spend cap" : retry ? "Will retry" : "Failed"],
      );
      if (job.project_id && !retry) {
        await pool.query(`UPDATE creative_projects SET step_note = $2, updated_at = now() WHERE id = $1::uuid`, [job.project_id, msg]);
        // A final that failed for good hands the project back as "ready to film" (it was stuck in approved / clips,
        // where nothing — approve, edit words, film again — was allowed).
        // …but only when no clip is still being filmed (Make the video would otherwise send — and pay for — it again;
        // Try again resumes it instead).
        if (!paused && (job.kind === "project_final" || job.kind === "project_test_clip")) {
          const filming = await pool.query(`SELECT 1 FROM creative_generations WHERE project_id = $1::uuid AND kind = 'clip' AND status = 'running' LIMIT 1`, [job.project_id]);
          if (!filming.rows[0]) await pool.query(`UPDATE creative_projects SET status = 'draft' WHERE id = $1::uuid AND status IN ('approved','clips')`, [job.project_id]);
        }
        // New concepts that failed: the old concepts can be picked again.
        if (job.kind === "project_concepts")
          await pool.query(`UPDATE creative_projects SET status = 'concepts' WHERE id = $1::uuid AND status = 'brief' AND concepts IS NOT NULL AND jsonb_array_length(concepts) > 0`, [job.project_id]);
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
