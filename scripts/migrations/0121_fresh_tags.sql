-- 0121_fresh_tags.sql
--
-- Fresh tags (owner, 2026-10-16). A tag number that passes ingress but was
-- never recorded in the WMS — no items row, never printed, encoded,
-- re-encoded or transferred — and that a scan just found enters as UNKNOWN,
-- marked "new, not verified" (fresh_found_at = when it was first read; the
-- source_device_* columns say what read it). It stays UNKNOWN on every later
-- read until a person changes its status (Status Change, Cloud + Geiger →
-- Take an action, bulk status); that first change stamps verified_at
-- (trigger below). A tag already known goes LIVE on a scan as before.
--
-- Count reports list the fresh tags each count found; Reports → New Unknown
-- tags lists the ones still waiting (fresh_found_at set, verified_at null).
--
-- Idempotent; lock_timeout bounds the ALTER / CREATE TRIGGER locks on items.

SET lock_timeout = '10s';

ALTER TABLE public.items
  ADD COLUMN IF NOT EXISTS fresh_found_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz NULL;

CREATE INDEX IF NOT EXISTS items_fresh_unverified_idx
  ON public.items (fresh_found_at)
  WHERE fresh_found_at IS NOT NULL AND verified_at IS NULL;

CREATE OR REPLACE FUNCTION items_fresh_verified()
RETURNS trigger AS $$
BEGIN
  IF OLD.fresh_found_at IS NOT NULL AND OLD.verified_at IS NULL
     AND OLD.status = 'unknown' AND NEW.status IS DISTINCT FROM 'unknown' THEN
    NEW.verified_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_fresh_verified_trg ON public.items;
CREATE TRIGGER items_fresh_verified_trg
  BEFORE UPDATE OF status ON public.items
  FOR EACH ROW EXECUTE FUNCTION items_fresh_verified();
