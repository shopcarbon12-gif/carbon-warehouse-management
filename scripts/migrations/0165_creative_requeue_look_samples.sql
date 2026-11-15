-- The 0164 Look-samples batch was picked up by the sync worker before its redeploy ("no handler for
-- preset_samples"). Put that job back in the queue. Idempotent: matches only that error.
UPDATE public.creative_jobs
   SET status = 'queued', error = NULL, attempts = 0, run_after = now(), progress = 'Queued for the OpenAI batch (half price)', updated_at = now()
 WHERE kind = 'preset_samples' AND status = 'failed' AND error LIKE '%no handler for preset_samples%';
