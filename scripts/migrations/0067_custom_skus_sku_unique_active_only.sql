-- Make custom_skus.sku unique ONLY among active (non-archived) rows.
--
-- Problem the global unique constraint caused: when Lightspeed re-keys a
-- variant (e.g. ls_system_id 210000007120 → 210000007125 for the same
-- physical product, sku stays '212355907OS'), the next sync tries to
-- INSERT the new ls_system_id row carrying the same sku. The old row is
-- still active at that moment (archive happens at the end of apply), so
-- the INSERT collides on the unique sku, gets rolled back inside the
-- per-variant SAVEPOINT, and the new variant is silently dropped from
-- the catalog. The sync reports "completed" but the operator can't find
-- the item.
--
-- Partial unique index (WHERE archived = FALSE) means:
--   - Two archived rows can share a sku (history preservation works)
--   - One active + one archived row can share a sku (re-keying works)
--   - Two active rows still cannot share a sku (data integrity preserved)
--
-- Combined with the apply-phase change to archive lost rows BEFORE
-- upserting incoming rows, the re-key path now works: archive vacates
-- the sku, the incoming insert claims it.

ALTER TABLE custom_skus DROP CONSTRAINT IF EXISTS variants_sku_unique;

CREATE UNIQUE INDEX IF NOT EXISTS custom_skus_sku_active_uq
  ON custom_skus (sku)
 WHERE archived = FALSE;
