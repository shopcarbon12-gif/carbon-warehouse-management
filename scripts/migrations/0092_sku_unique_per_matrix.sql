-- A SKU may be live on two different products, as long as they are two different
-- items.
--
-- custom_skus_sku_active_uq made a SKU unique across the WHOLE catalog while
-- unarchived. That is stricter than this system needs: a tag is read by its
-- ls_system_id, not its SKU — lib/server/epc-ingress.ts resolves a scan with
-- `SELECT id FROM custom_skus WHERE ls_system_id = $1`, and ls_system_id already
-- carries its own global unique index. Two rows with the same SKU but different
-- system ids are two distinct items and both can be live.
--
-- It also blocked real work: two matrices can share a UPC (47 do), a SKU is
-- UPC + color code + size, so whichever product went live first permanently
-- blocked the other from being unarchived — 44 rows were stuck this way, e.g.
-- Kyle Cargo Pants' GREY sizes behind Cole Pants Set's.
--
-- Uniqueness is kept where it is still true: the same SKU twice inside one
-- product is a duplicate, and that stays refused.

DROP INDEX IF EXISTS custom_skus_sku_active_uq;

CREATE UNIQUE INDEX IF NOT EXISTS custom_skus_matrix_sku_active_uq
  ON custom_skus (matrix_id, sku) WHERE archived = false;
