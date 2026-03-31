-- Idempotent repair: hosts that skipped earlier migrations may lack bins.status (required by listBinsWithCounts).
-- Safe to re-run; mirrors the bins portion of 007_warehouse_map_devices.sql.

ALTER TABLE bins DROP CONSTRAINT IF EXISTS bins_status_check;
--> statement-breakpoint
ALTER TABLE bins ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE bins ADD CONSTRAINT bins_status_check CHECK (status IN ('active', 'inactive'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
