-- v2.6: extend items.status for dashboard KPIs + commissioning (idempotent).
-- Runs after 0040/0041. Skips safely if `items` was never created (e.g. custom_skus absent).
DO $$
BEGIN
  IF to_regclass('public.items') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check;

  BEGIN
    -- Superset of every status this migration runner could encounter on
    -- existing dev DBs. Migration 019 (which sorts AFTER this one in the
    -- runner's alphanumeric order) replaces this with the canonical modern
    -- set ('in-stock','return','damaged','sold','stolen','tag_killed',
    -- 'pending_visibility','in-transit','pending_transaction'); this list
    -- only needs to be permissive enough that pre-019 rows don't fail
    -- 0042 on the way through. 'tag_killed' and 'damaged' were added to
    -- this list because dev DBs already contain those values from prior
    -- runs of 019 / 008 respectively.
    ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN (
      'in-stock',
      'sold',
      'in-transit',
      'missing',
      'damaged',
      'tag_killed',
      'INCOMPLETE',
      'UNKNOWN',
      'COMMISSIONED'
    ));
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;
