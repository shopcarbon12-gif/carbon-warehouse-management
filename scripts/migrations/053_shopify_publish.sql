-- 2026-08-12 — WMS → Shopify publishing (M1 foundation).
--
-- WMS becomes the source of truth for the catalog; products authored here
-- are published to Shopify. This migration is ADDITIVE ONLY — it never
-- touches or drops an existing column, so the (now disabled) Lightspeed
-- catalog upsert cannot clobber any of it, and RFID/EPC encoding is
-- untouched. `ls_system_id` is KEPT AS-IS (it is the EPC item reference);
-- new WMS-authored items simply allocate it themselves.
--
-- All statements are idempotent — the incremental runner re-applies every
-- file on each `db:migrate`, so guard with IF NOT EXISTS everywhere.
--
--   matrices:     approval + Shopify identity + publish state + SEO marker
--   custom_skus:  per-variant Shopify identity (variant + inventory + media)
--   catalog_metafields:        WMS → Shopify metafield bindings/values
--   shopify_metaobject_cache:  label → taxonomy metaobject GID resolver cache

-- ── Product (matrix) level ────────────────────────────────────────────────
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS checked_at          timestamptz;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS checked_by          uuid;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS shopify_product_id  text;      -- gid://shopify/Product/…
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS shopify_sync_status text;      -- pending|pushing|published|held|error
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS shopify_pushed_at   timestamptz;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS shopify_push_error  text;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS seo_optimized_at    timestamptz;

-- One Shopify product per matrix — enforce uniqueness where set (partial index).
CREATE UNIQUE INDEX IF NOT EXISTS matrices_shopify_product_id_uq
  ON matrices (shopify_product_id) WHERE shopify_product_id IS NOT NULL;

-- ── Variant (custom_sku) level ────────────────────────────────────────────
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS shopify_variant_id        text;  -- gid://shopify/ProductVariant/…
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS shopify_inventory_item_id text;
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS shopify_media_id          text;  -- the color's main media gid

CREATE UNIQUE INDEX IF NOT EXISTS custom_skus_shopify_variant_id_uq
  ON custom_skus (shopify_variant_id) WHERE shopify_variant_id IS NOT NULL;

-- ── Metafield bindings (WMS → Shopify) ────────────────────────────────────
-- One row per (owner, namespace, key). owner = matrix (product-level) OR
-- custom_sku (variant-level, e.g. Google-feed per-variant fields).
CREATE TABLE IF NOT EXISTS catalog_metafields (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_id     uuid REFERENCES matrices(id)     ON DELETE CASCADE,
  custom_sku_id uuid REFERENCES custom_skus(id)  ON DELETE CASCADE, -- null ⇒ product-level
  namespace     text NOT NULL,      -- 'custom' | 'mm-google-shopping' | 'shopify'
  key           text NOT NULL,      -- 'short_descriptions_' | 'gender' | 'fabric' …
  type          text NOT NULL,      -- Shopify metafield type
  value         text,               -- resolved value or metaobject gid(s) JSON
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_metafields_owner_ck
    CHECK (matrix_id IS NOT NULL OR custom_sku_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS catalog_metafields_matrix_idx     ON catalog_metafields (matrix_id);
CREATE INDEX IF NOT EXISTS catalog_metafields_custom_sku_idx ON catalog_metafields (custom_sku_id);
-- Product-level uniqueness (owner + namespace + key)
CREATE UNIQUE INDEX IF NOT EXISTS catalog_metafields_matrix_key_uq
  ON catalog_metafields (matrix_id, namespace, key) WHERE matrix_id IS NOT NULL AND custom_sku_id IS NULL;
-- Variant-level uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS catalog_metafields_sku_key_uq
  ON catalog_metafields (custom_sku_id, namespace, key) WHERE custom_sku_id IS NOT NULL;

-- ── Taxonomy metaobject resolver cache ────────────────────────────────────
-- Maps a human label ("Navy", "Cotton") under a taxonomy definition
-- ("shopify.color-pattern") to its Shopify metaobject GID, so publishing
-- taxonomy metafields is fast and offline-resolvable after first fetch.
CREATE TABLE IF NOT EXISTS shopify_metaobject_cache (
  definition_key text NOT NULL,     -- e.g. 'shopify.color-pattern'
  label          text NOT NULL,     -- e.g. 'Navy'
  gid            text NOT NULL,     -- gid://shopify/Metaobject/…
  refreshed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (definition_key, label)
);
