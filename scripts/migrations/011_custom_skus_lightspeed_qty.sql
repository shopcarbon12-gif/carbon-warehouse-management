-- Lightspeed total on-hand (catalog sync); RFID EPC counts stay on `items`.
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS ls_on_hand_total integer;
--> statement-breakpoint
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS ls_qty_synced_at timestamptz;
