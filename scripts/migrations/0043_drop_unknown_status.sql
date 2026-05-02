-- 0043: Drop the redundant 'UNKNOWN' status. Functionally identical to
-- 'tag_killed' (scanner + UI hidden, handhelds ignore), so the dropdown
-- entry was dead weight. Migration is idempotent: re-running is a no-op.

DO $$
BEGIN
  IF to_regclass('public.items') IS NULL THEN
    RETURN;
  END IF;

  -- Demote any leftover items.status = 'UNKNOWN' to 'tag_killed' before the
  -- CHECK constraint stops accepting it. Per the operator the table was wiped
  -- before this migration shipped, so this is defensive only.
  UPDATE items SET status = 'tag_killed' WHERE status = 'UNKNOWN';

  -- Swap the CHECK constraint to the post-removal allowed set.
  ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check;
  BEGIN
    ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN (
      'in-stock',
      'return',
      'damaged',
      'sold',
      'stolen',
      'tag_killed',
      'pending_visibility',
      'in-transit',
      'pending_transaction'
    ));
  EXCEPTION
    WHEN duplicate_object THEN NULL;
  END;
END $$;
--> statement-breakpoint

-- Drop the status_labels row so the Settings → Statuses page stops listing it.
DELETE FROM status_labels WHERE name = 'UNKNOWN';
