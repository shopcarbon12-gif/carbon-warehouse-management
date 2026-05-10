-- 2026-05-10 — track which user created each item.
--
-- Until now items.created_at was the only timeline signal, with no
-- user attribution at all. Operator question "who added the last EPC?"
-- could only be answered by time-correlating audit_log entries from
-- nearby reader-pause/resume actions, which is fragile and noisy.
--
-- New column is nullable on purpose:
--   * NULL = system-discovered (cdm reads ingest path, where the
--     authenticated principal is the agent token, not a user)
--   * NULL = imported (one-time Senitron snapshot script)
--   * Set  = explicit operator action (commission, encode-claim, future
--     mobile Transfer In endpoints)
--
-- Foreign key uses ON DELETE SET NULL so deactivating a user doesn't
-- block item deletion or cascade unintentionally.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS created_by_user_id UUID
  REFERENCES users(id) ON DELETE SET NULL;

-- Per-user "what did I create" lookups + per-user audit windows. Time
-- DESC index pairs cleanly with `WHERE created_by_user_id = $1
-- ORDER BY created_at DESC LIMIT N`.
CREATE INDEX IF NOT EXISTS items_created_by_user_id_created_at_idx
  ON items (created_by_user_id, created_at DESC)
  WHERE created_by_user_id IS NOT NULL;
