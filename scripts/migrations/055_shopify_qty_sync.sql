-- 2026-08-12 — Shopify inventory quantity sync (WMS is the source of truth).
--
-- Tracks the last quantity WMS pushed to Shopify per variant, so the ongoing
-- auto-sync only writes variants whose WMS on-hand actually changed. Additive,
-- idempotent.
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS shopify_qty_synced      integer;
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS shopify_qty_synced_at   timestamptz;
