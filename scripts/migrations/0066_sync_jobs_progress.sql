-- Lightspeed sync: progress tracking + preview caching.
--
-- Extends sync_jobs to support the new preview-and-confirm flow:
--   1. progress_done / progress_total / progress_pct / progress_message —
--      live counters the UI polls every 1.5s while a sync is running.
--      Surfaces the global top-right progress bar that follows the
--      operator across pages.
--   2. preview_token — opaque key the modal uses to download the diff
--      Excel file and to apply the cached preview. Distinct from id so
--      we can rotate it without orphaning history rows.
--   3. started_at / finished_at — independent of created_at so a queued
--      job's wait time is visible.
--
-- Status semantics tightened to reflect the new flow:
--   'preview'         — fetched + diff computed, awaiting operator confirm
--   'running'         — apply phase in progress; progress_* are live
--   'completed'       — apply finished successfully
--   'failed'          — apply errored; `error` carries the message
--   'cancelled'       — operator dismissed the preview without confirming

ALTER TABLE sync_jobs
  ADD COLUMN IF NOT EXISTS progress_done    INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_total   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_pct     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_message TEXT,
  ADD COLUMN IF NOT EXISTS preview_token    TEXT,
  ADD COLUMN IF NOT EXISTS started_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at      TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS sync_jobs_preview_token_uq
  ON sync_jobs (preview_token)
 WHERE preview_token IS NOT NULL;
