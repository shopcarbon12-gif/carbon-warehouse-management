-- Variant-level "home bin" assignment.
--
-- Assigning a colour to a bin should cover EVERY size of that colour — even
-- sizes with zero on-hand (no EPCs to pin) — so the catalog shows the whole
-- colour as assigned. items.bin_id can only ever carry a bin for a size that
-- has a live EPC, so we add a per-variant home bin that does not depend on
-- stock. The catalog grid falls back to this when a variant has no in-stock
-- items. Bin SCANNING is unaffected — it reads live items only.

ALTER TABLE custom_skus
  ADD COLUMN IF NOT EXISTS assigned_bin_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'custom_skus_assigned_bin_id_fkey'
  ) THEN
    ALTER TABLE custom_skus
      ADD CONSTRAINT custom_skus_assigned_bin_id_fkey
      FOREIGN KEY (assigned_bin_id) REFERENCES bins(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_custom_skus_assigned_bin
  ON custom_skus(assigned_bin_id);
