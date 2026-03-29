-- v2.10: Allow handheld STATUS_CHANGE workflow to mark units as damaged.
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN (
    'in-stock',
    'sold',
    'in-transit',
    'missing',
    'damaged',
    'INCOMPLETE',
    'UNKNOWN',
    'COMMISSIONED'
  ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
