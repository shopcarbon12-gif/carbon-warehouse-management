-- Count review & push (owner, 2026-10-15) + the Add-On re-open fix.
--
-- 1. Re-opening a completed Add-On count answered "Reopen failed" (HTTP 500)
--    although it did re-open: reopenSession() logs a 'reopened' event and the
--    0054 CHECK never listed it, so the last INSERT threw after the state had
--    already changed. Added to the list (NOT VALID + VALIDATE: no long lock on
--    a busy table).
-- 2. count_pushes: one row per push from the Counts review page (which files,
--    add vs override, what changed), and inventory_reports.pushed_* so a file
--    is never pushed twice. Idempotent.
SET lock_timeout = '10s';

ALTER TABLE add_on_session_events DROP CONSTRAINT IF EXISTS add_on_session_events_event_type_check;
ALTER TABLE add_on_session_events ADD CONSTRAINT add_on_session_events_event_type_check CHECK (event_type IN (
  'started','joined','join_requested','join_approved','join_declined',
  'epc_new','epc_duplicate','epc_failed',
  'paused','resumed','signed_out','heartbeat','completed','cancelled','reopened'
)) NOT VALID;
ALTER TABLE add_on_session_events VALIDATE CONSTRAINT add_on_session_events_event_type_check;

CREATE TABLE IF NOT EXISTS count_pushes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  location_id  uuid NOT NULL,
  pushed_by    uuid,
  mode         text NOT NULL CHECK (mode IN ('add', 'override')),
  report_ids   uuid[] NOT NULL,
  summary      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS count_pushes_tenant_idx ON count_pushes (tenant_id, created_at DESC);

ALTER TABLE inventory_reports ADD COLUMN IF NOT EXISTS pushed_at timestamptz;
ALTER TABLE inventory_reports ADD COLUMN IF NOT EXISTS pushed_by uuid;
ALTER TABLE inventory_reports ADD COLUMN IF NOT EXISTS push_id uuid;

RESET lock_timeout;
