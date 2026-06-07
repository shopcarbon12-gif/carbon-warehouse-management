-- 2026-06-07 — Catalog product imagery sourced from Shopify.
--
-- Two display surfaces in /inventory/catalog need pictures:
--   • Item popup (per custom_sku / variant) shows ONE picture — the
--     variant's color-specific Shopify image. Stored on custom_skus.
--   • Matrix window (per matrix / UPC) shows the FULL Shopify product
--     gallery, in Shopify order. Stored on matrices as an ordered JSONB
--     array of CDN URLs.
--
-- We KEEP Shopify CDN links (cdn.shopify.com/...) verbatim — images are
-- never re-hosted. Columns are nullable / default-empty so every product
-- without a Shopify sync simply renders no image. Population is done by
-- lib/server/shopify-catalog-images.ts (one matrix at a time today; a
-- full sweep later).
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS shopify_image_url TEXT;
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS shopify_images_synced_at TIMESTAMPTZ;

ALTER TABLE matrices ADD COLUMN IF NOT EXISTS shopify_image_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS shopify_featured_image_url TEXT;
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS shopify_images_synced_at TIMESTAMPTZ;
