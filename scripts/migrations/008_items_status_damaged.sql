-- v2.10: Allow handheld STATUS_CHANGE workflow to mark units as damaged.
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check;
--> statement-breakpoint
DO $$
BEGIN
  -- 'tag_killed' included as a permissive superset: the migration runner
  -- can apply 008 AFTER 019 has already remapped rows to 'tag_killed' on
  -- dev DBs (the runner's alphanumeric sort puts 0040.. before 008 before
  -- 019). Migration 019 then DROPs and re-ADDs the canonical modern set.
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
END $$;
