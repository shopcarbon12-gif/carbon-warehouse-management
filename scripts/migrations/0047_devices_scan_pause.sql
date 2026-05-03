-- 2026-05-03 — per-reader pause + schedule.
--
-- scan_paused_at: NULL = not manually paused. Stamp = manually paused at
-- this time (admin clicked Pause on the reader row). Wins over schedule.
-- scan_paused_by: who clicked Pause (audit only).
-- scan_schedule: optional JSON describing a weekly pause schedule. Server
-- evaluates per-reader on every config-bundle response. Shape:
--   { "timezone": "America/New_York",
--     "windows": [ { "days": [0..6], "from": "HH:MM", "to": "HH:MM" } ] }
-- Days are 0=Sunday..6=Saturday. Windows that cross midnight are
-- supported (to < from).
--
-- A reader is "scanning" only when ALL of:
--   1. live_scan_active (dashboard master toggle, see Phase 1)
--   2. scan_paused_at IS NULL
--   3. schedule does not put us in a paused window right now
ALTER TABLE devices ADD COLUMN IF NOT EXISTS scan_paused_at  TIMESTAMPTZ;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS scan_paused_by  UUID REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS scan_schedule   JSONB;
