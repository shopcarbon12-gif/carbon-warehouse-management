-- Catalog archive flag (Lightspeed R-Series).
-- Variants flagged as archived in Lightspeed are now synced (instead of being
-- filtered out at fetch time). The catalog grid hides archived rows by default
-- and offers a "Show archived" toggle. Matrix-level archive is derived in SQL
-- (`bool_and(cs.archived) OVER (PARTITION BY cs.matrix_id)`).
ALTER TABLE custom_skus
  ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS custom_skus_archived_idx
  ON custom_skus (archived) WHERE archived = TRUE;

-- Count uploads stamp `last_seen_at` so cycle-count + freshness reports can
-- distinguish recently-scanned items from stale ones.
ALTER TABLE items
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
