-- Defensive backfill for migration 033's columns. Migration 033 batched four
-- ALTER statements into a single segment which can land partial under some
-- pg client modes; this re-runs each as its own statement so missing columns
-- show up cleanly. All ALTERs are IF NOT EXISTS, so this is a no-op on DBs
-- where 033 fully applied.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS test_pending_at      TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_at          TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_passed      BOOLEAN;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_test_epc_count   INT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS devices_test_pending_idx
  ON devices (test_pending_at)
  WHERE test_pending_at IS NOT NULL;
