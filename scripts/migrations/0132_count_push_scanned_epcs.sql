-- A pushed count (Reports → Counts → Combine & review → push) is the latest
-- count once pushed. Keep its combined tag list so the dashboard's Defective
-- EPCs tile and Last count pill can use it, like a committed cycle count's
-- cycle_count_sessions.scanned_epcs (owner 2026-10-22: the tile still read the
-- 2026-09-02 count after the 2026-10-14 count was pushed).
ALTER TABLE count_pushes ADD COLUMN IF NOT EXISTS scanned_epcs jsonb;
