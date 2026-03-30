-- Rename 016 behavioral columns to legacy-aligned names (016 file was already used).
-- Idempotent: safe if 018 runs twice or columns were created with new names manually.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'auto_display_if_tags_present'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'auto_display'
  ) THEN
    ALTER TABLE status_labels RENAME COLUMN auto_display_if_tags_present TO auto_display;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'allow_instant_stolen_api'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'allow_stolen_api'
  ) THEN
    ALTER TABLE status_labels RENAME COLUMN allow_instant_stolen_api TO allow_stolen_api;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'prevent_live_on_transfer_receive'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'prevent_transfer'
  ) THEN
    ALTER TABLE status_labels RENAME COLUMN prevent_live_on_transfer_receive TO prevent_transfer;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'prevent_change_during_audit_request'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'prevent_audit'
  ) THEN
    ALTER TABLE status_labels RENAME COLUMN prevent_change_during_audit_request TO prevent_audit;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'prevent_live_after_inventory_upload_script'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'status_labels' AND column_name = 'prevent_upload_to_live'
  ) THEN
    ALTER TABLE status_labels RENAME COLUMN prevent_live_after_inventory_upload_script TO prevent_upload_to_live;
  END IF;
END $$;
