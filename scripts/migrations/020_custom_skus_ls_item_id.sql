-- R-Series Lightspeed numeric itemID (from catalog Item.itemID) for PUT Item/{id} and transfer AddItems.

ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS ls_item_id bigint;

CREATE INDEX IF NOT EXISTS custom_skus_ls_item_id_idx
  ON custom_skus (ls_item_id)
  WHERE ls_item_id IS NOT NULL;
