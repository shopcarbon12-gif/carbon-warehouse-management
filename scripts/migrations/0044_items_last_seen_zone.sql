-- 0044: Track each EPC's last-seen zone so we can emit zone-change audit
-- events for the EPC tracker timeline. The CDM agents.ts ingest path
-- compares the read's reader.zone_id against this column, writes an
-- 'rfid_zone_change' audit row when they differ, then updates the column.

DO $$
BEGIN
  IF to_regclass('public.items') IS NULL THEN
    RETURN;
  END IF;

  ALTER TABLE items ADD COLUMN IF NOT EXISTS last_seen_zone_id uuid NULL;
END $$;
