-- Manual (non-RFID) catalog items.
--
-- When a matrix is flagged is_manual_only = TRUE, every custom_sku under it
-- is treated as a manual item: the catalog grid swaps its EPC count for
-- the Lightspeed on-hand total (+ any settled inventory_adjustments delta),
-- and the catalog row's RFID button renders as a "Manual" badge instead of
-- the EPCs viewer. Driven by /inventory/catalog → More → Manual Items.

ALTER TABLE matrices
  ADD COLUMN IF NOT EXISTS is_manual_only BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS matrices_is_manual_only_idx
  ON matrices (is_manual_only)
  WHERE is_manual_only = TRUE;
