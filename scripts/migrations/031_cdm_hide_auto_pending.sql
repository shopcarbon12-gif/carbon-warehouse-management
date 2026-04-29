-- v3.3: Hide the AUTO-PENDING placeholder SKU from the default catalog view.
-- The row stays in the DB (so auto-commission keeps working and we can
-- pull data from it later), it's just marked archived. The catalog UI's
-- "Show archived" toggle still surfaces it on demand.
--
-- The parent matrix "Auto-commissioned (Pending)" is also effectively
-- hidden because the catalog list computes matrix_archived = bool_and of
-- all its SKUs' archived flag — and AUTO-PENDING is its only child.

UPDATE custom_skus
   SET archived = TRUE
 WHERE sku = 'AUTO-PENDING'
   AND archived = FALSE;
