-- 039 — drop UNIQUE on matrices.upc.
--
-- Lightspeed ItemMatrices can legitimately share a UPC across distinct
-- matrices (two unrelated products with the same printed barcode). The old
-- upsert in lib/server/inventory-sync.ts used `ON CONFLICT (upc)` and
-- collapsed two LS matrices into one WMS row, merging their variants and
-- overwriting the parent's name/brand/category with whichever LS matrix
-- synced second.
--
-- Identity moves to `ls_system_id` (Lightspeed's itemMatrixID), which already
-- has a partial unique index from migration 006 (matrices_ls_system_id_uidx).
-- UPC becomes a non-unique searchable attribute.
--
-- Search paths that ILIKE on m.upc (inventory-catalog.ts, rfid-commission.ts)
-- still benefit from a B-tree, so we add a plain partial index in place of
-- the implicit one the unique constraint provided.
--
-- IDEMPOTENT — safe to run on every container start.

ALTER TABLE matrices DROP CONSTRAINT IF EXISTS products_upc_unique;
--> statement-breakpoint
-- The 002 constraint kept its original `products_*` name across the rename
-- to `matrices` (003). Double-tap the modern name in case any environment
-- was reseeded with the renamed name.
ALTER TABLE matrices DROP CONSTRAINT IF EXISTS matrices_upc_unique;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS matrices_upc_idx
  ON matrices (upc)
  WHERE upc IS NOT NULL AND trim(upc) <> '';
