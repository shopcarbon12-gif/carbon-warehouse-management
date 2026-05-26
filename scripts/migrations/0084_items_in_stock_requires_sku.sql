-- 0084_items_in_stock_requires_sku.sql
--
-- Enforce the invariant: items.status='in-stock' REQUIRES a non-null
-- custom_sku_id. "Live inventory with no catalog match" is incoherent
-- — the EPC either decodes to a known SKU (in-stock) or it doesn't
-- (tag_killed, visible in Defective EPCs).
--
-- Live evidence 2026-05-26: at least one foreign-prefix EPC
-- (`30129CBFD880004000002699`) landed as in-stock with custom_sku_id
-- NULL despite the cycle-count-scan audit recording `new_status:
-- tag_killed`. Some downstream path (TBD) silently UPDATEs status to
-- in-stock without re-checking the SKU. Rather than hunt the path,
-- enforce the invariant at the DB layer so no caller can violate it.

-- Step 1: heal existing violators. The audit_log already shows the
-- correct intended status (tag_killed); we just align the items row.
UPDATE public.items
   SET status = 'tag_killed'
 WHERE status = 'in-stock'
   AND custom_sku_id IS NULL;

-- Step 2: BEFORE INSERT/UPDATE trigger silently demotes any future
-- attempt to set status='in-stock' on a SKU-less row to tag_killed.
-- This is intentionally a trigger (not a CHECK constraint) so callers
-- don't see hard rejections — the row still writes, just with the
-- correct status. The defective-EPCs UI surfaces the row so an
-- operator can investigate.
CREATE OR REPLACE FUNCTION items_enforce_in_stock_has_sku()
RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'in-stock' AND NEW.custom_sku_id IS NULL THEN
    NEW.status := 'tag_killed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS items_enforce_in_stock_has_sku_trg ON public.items;
CREATE TRIGGER items_enforce_in_stock_has_sku_trg
  BEFORE INSERT OR UPDATE OF status, custom_sku_id ON public.items
  FOR EACH ROW
  EXECUTE FUNCTION items_enforce_in_stock_has_sku();
