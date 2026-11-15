-- CarbonWMS Creative — at most ONE open job per project + kind (review 2026-11-15: a double tap queued two
-- project_final jobs = every clip paid twice). enqueue() checks first; this index closes the race. If older
-- duplicates are open the index is skipped (logged) rather than failing the deploy; it is retried next deploy.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'creative_jobs_one_open') THEN
    BEGIN
      CREATE UNIQUE INDEX creative_jobs_one_open ON public.creative_jobs (project_id, kind)
        WHERE project_id IS NOT NULL AND status IN ('queued', 'running', 'waiting', 'paused');
    EXCEPTION WHEN unique_violation THEN
      RAISE NOTICE 'creative_jobs_one_open skipped: duplicate open jobs exist';
    END;
  END IF;
END $$;
