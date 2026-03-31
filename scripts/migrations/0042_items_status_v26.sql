-- v2.6: extend items.status for dashboard KPIs + commissioning (idempotent).
-- Runs after 0040/0041. Skips safely if `items` was never created (e.g. custom_skus absent).
DO $$
BEGIN
  IF to_regclass('public.items') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check;

  BEGIN
    ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN (
      'in-stock',
      'sold',
      'in-transit',
      'missing',
      'INCOMPLETE',
      'UNKNOWN',
      'COMMISSIONED'
    ));
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;
