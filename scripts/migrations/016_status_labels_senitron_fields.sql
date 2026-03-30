-- Carbon WMS: optional UI label + extended status behavior flags (column names renamed in 018).
ALTER TABLE status_labels
  ADD COLUMN IF NOT EXISTS display_label TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE status_labels
  ADD COLUMN IF NOT EXISTS auto_display_if_tags_present BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels
  ADD COLUMN IF NOT EXISTS allow_instant_stolen_api BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels
  ADD COLUMN IF NOT EXISTS prevent_live_on_transfer_receive BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels
  ADD COLUMN IF NOT EXISTS prevent_change_during_audit_request BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels
  ADD COLUMN IF NOT EXISTS prevent_live_after_inventory_upload_script BOOLEAN NOT NULL DEFAULT false;
