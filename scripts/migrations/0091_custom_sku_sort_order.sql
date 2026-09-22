-- Manual variant order for a matrix.
--
-- Sizes are shown in canonical order (lib/inventory/size-order.ts: XS S M L XL,
-- 26 27 28, 36 37 38) rather than the alphabetical order the database returns,
-- which puts L before M before S. That covers every product in the catalog today.
--
-- sort_order exists for the cases canonical order cannot know about: a product
-- whose sizes should run in some house order of its own. The matrix modal writes
-- it for every row of a matrix whenever the group items are saved, so a matrix is
-- either fully ordered or fully NULL — never half. NULL rows (a variant added
-- since the last save) sort last within their color, then by canonical size.
--
-- The same order is what gets pushed to Shopify, so the size selector on the
-- product page matches the WMS.

ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS sort_order integer;

CREATE INDEX IF NOT EXISTS custom_skus_matrix_sort_idx
  ON custom_skus (matrix_id, sort_order);
