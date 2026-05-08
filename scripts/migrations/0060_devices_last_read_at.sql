-- 2026-05-08 — antenna freshness tracking for Hardware Config online dot.
--
-- Replaces the sticky-true `status_online` rule for antennas. Until now the
-- ingest path flipped `status_online = true` on every read but never flipped
-- it back, so a tag scanned once kept that antenna green forever even if its
-- coax was unplugged a week later. New rule (computed server-side in
-- lib/server/hardware-config.ts):
--
--   antenna.status_online =
--     parent_reader.is_paused_or_stopped
--     OR (last_read_at > now() - interval '60 seconds')
--
-- The bypass for paused/stopped readers preserves the operator's "I turned
-- this reader off on purpose, don't punish its antennas" intent — matches
-- the Hardware Config UX expectation.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS devices_last_read_at_idx
  ON devices (last_read_at)
  WHERE device_type = 'antenna';
