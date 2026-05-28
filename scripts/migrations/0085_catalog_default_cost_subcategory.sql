-- Adds two catalog dimensions exposed in /inventory/catalog:
--
--   custom_skus.default_cost (variant-level) — landed/wholesale unit cost,
--     numeric(12,4) to preserve Lightspeed's 4-decimal cost precision; sits
--     next to retail_price.
--
--   matrices.subcategory_1 (matrix-level) — second-tier merchandise tag
--     (e.g. category=WOMEN, subcategory_1=DRESS), sized to match the
--     existing category column.
--
-- Both columns are NULL by default; first population is a one-shot import
-- from Lightspeed's item_listings export keyed on custom_skus.ls_system_id
-- with a fallback to custom_skus.sku.

ALTER TABLE custom_skus
  ADD COLUMN IF NOT EXISTS default_cost numeric(12, 4);

ALTER TABLE matrices
  ADD COLUMN IF NOT EXISTS subcategory_1 varchar(128);
