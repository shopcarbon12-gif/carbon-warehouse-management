-- CarbonWMS Creative — make sure the one-open-job index exists (0179 skipped it silently if duplicates were open,
-- and migrations run once per file). Older duplicates are cancelled first, then the index is created.
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY project_id, kind ORDER BY created_at DESC) AS rn
    FROM public.creative_jobs
   WHERE project_id IS NOT NULL AND status IN ('queued', 'running', 'waiting', 'paused')
)
UPDATE public.creative_jobs j SET status = 'cancelled', progress = 'Duplicate of a newer job', updated_at = now()
  FROM ranked r WHERE j.id = r.id AND r.rn > 1;
CREATE UNIQUE INDEX IF NOT EXISTS creative_jobs_one_open ON public.creative_jobs (project_id, kind)
  WHERE project_id IS NOT NULL AND status IN ('queued', 'running', 'waiting', 'paused');
