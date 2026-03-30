-- Clean 10: void legacy Senitron checkbox columns; hard-wired Carbon WMS status brain.
-- Destructive: truncates status_labels and remaps items.status to the new WMS vocabulary.

--> statement-breakpoint
ALTER TABLE status_labels ADD COLUMN IF NOT EXISTS is_sellable BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels ADD COLUMN IF NOT EXISTS is_visible_to_scanner BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels ADD COLUMN IF NOT EXISTS is_visible_in_ui BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels ADD COLUMN IF NOT EXISTS super_admin_locked BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels ADD COLUMN IF NOT EXISTS is_system_only BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE status_labels
  DROP COLUMN IF EXISTS include_in_inventory,
  DROP COLUMN IF EXISTS hide_in_search_filters,
  DROP COLUMN IF EXISTS hide_in_item_details,
  DROP COLUMN IF EXISTS display_in_group_page,
  DROP COLUMN IF EXISTS auto_display,
  DROP COLUMN IF EXISTS auto_display_if_tags_present,
  DROP COLUMN IF EXISTS allow_stolen_api,
  DROP COLUMN IF EXISTS allow_instant_stolen_api,
  DROP COLUMN IF EXISTS prevent_transfer,
  DROP COLUMN IF EXISTS prevent_live_on_transfer_receive,
  DROP COLUMN IF EXISTS prevent_audit,
  DROP COLUMN IF EXISTS prevent_change_during_audit_request,
  DROP COLUMN IF EXISTS prevent_upload_to_live,
  DROP COLUMN IF EXISTS prevent_live_after_inventory_upload_script;
--> statement-breakpoint
TRUNCATE TABLE status_labels RESTART IDENTITY;
--> statement-breakpoint
INSERT INTO status_labels (
  legacy_id, name, display_label,
  is_sellable, is_visible_to_scanner, is_visible_in_ui, super_admin_locked, is_system_only
) VALUES
  (1, 'LIVE', 'Live — sellable, visible everywhere', true, true, true, false, false),
  (2, 'RETURN', 'Return — not sellable; visible on handheld and in UI', false, true, true, false, false),
  (3, 'DAMAGED', 'Damaged — not sellable; only Super Admin can return to Live', false, true, true, true, false),
  (4, 'SOLD', 'Sold — not sellable; only Super Admin can return to Live', false, true, true, true, false),
  (5, 'STOLEN', 'Stolen — confirmed loss. Handhelds IGNORE this tag.', false, false, false, true, false),
  (6, 'TAG KILLED', 'Tag killed — scanner and UI hidden. Handhelds IGNORE.', false, false, false, true, false),
  (7, 'UNKNOWN', 'Unknown — scanner and UI hidden. Handhelds IGNORE.', false, false, false, true, false),
  (8, 'PENDING VISIBILITY', 'System staging — staff cannot select; handheld ignores.', false, false, false, true, true),
  (9, 'IN TRANSIT', 'In transit — system workflow; visible, not sellable', false, true, true, false, true),
  (10, 'PENDING TRANSACTION', 'Pending transaction — system workflow; visible, not sellable', false, true, true, false, true);
--> statement-breakpoint
-- Remap existing item statuses into the new CHECK set before constraint swap.
UPDATE items SET status = 'UNKNOWN' WHERE status IN ('missing', 'INCOMPLETE');
UPDATE items SET status = 'in-stock' WHERE status = 'COMMISSIONED';
--> statement-breakpoint
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check;
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN (
    'in-stock',
    'return',
    'damaged',
    'sold',
    'stolen',
    'tag_killed',
    'UNKNOWN',
    'pending_visibility',
    'in-transit',
    'pending_transaction'
  ));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
