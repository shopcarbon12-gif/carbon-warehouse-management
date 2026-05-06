-- 2026-05-05 — Add-On Count lock + completion columns on the 3 v1 source tables.
--
-- A "source" is a previously-recorded scan that an Add-On Count walks against.
-- Three tables host source rows in v1:
--   inventory_reports        — Mobile Count uploads (handheld archive)
--   cycle_count_sessions     — committed cycle-count sessions
--   device_upload_logs       — web/handheld CSV imports
--
-- Per-row state derived from these 3 columns:
--   FREE       → add_on_locked_by IS NULL AND add_on_completed_at IS NULL
--   IN_USE     → add_on_locked_by IS NOT NULL
--   COMPLETED  → add_on_completed_at IS NOT NULL (locks row from re-pick;
--                super-admin clears it manually to re-open).
--
-- Idempotent — ADD COLUMN IF NOT EXISTS so re-runs are no-ops.
ALTER TABLE inventory_reports
  ADD COLUMN IF NOT EXISTS add_on_locked_by      UUID,
  ADD COLUMN IF NOT EXISTS add_on_completed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS add_on_completed_by   UUID;
--> statement-breakpoint
ALTER TABLE cycle_count_sessions
  ADD COLUMN IF NOT EXISTS add_on_locked_by      UUID,
  ADD COLUMN IF NOT EXISTS add_on_completed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS add_on_completed_by   UUID;
--> statement-breakpoint
ALTER TABLE device_upload_logs
  ADD COLUMN IF NOT EXISTS add_on_locked_by      UUID,
  ADD COLUMN IF NOT EXISTS add_on_completed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS add_on_completed_by   UUID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_reports_add_on_state_idx
  ON inventory_reports (tenant_id, add_on_completed_at)
  WHERE add_on_completed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cycle_count_sessions_add_on_state_idx
  ON cycle_count_sessions (tenant_id, add_on_completed_at)
  WHERE add_on_completed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_upload_logs_add_on_state_idx
  ON device_upload_logs (tenant_id, add_on_completed_at)
  WHERE add_on_completed_at IS NULL;
