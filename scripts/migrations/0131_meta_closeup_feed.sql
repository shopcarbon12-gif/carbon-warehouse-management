-- Meta close-up picture feed (owner 2026-10-22): catalog ads on Facebook /
-- Instagram show each product in a square card, where a full-length photo
-- leaves the model small with white at the sides. A supplementary feed swaps
-- each variant's ad picture for a front close-up of the same colour; Shopify
-- itself is untouched. Store-level (one Shopify store), so no tenant.

-- Which view each Shopify product photo shows, so a photo is classified once.
CREATE TABLE IF NOT EXISTS meta_feed_views (
  image_key text PRIMARY KEY,
  view text NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now()
);

-- One row per Shopify variant that has a close-up: Meta's item id is the
-- variant's numeric id. Rebuilt in full by the worker.
CREATE TABLE IF NOT EXISTS meta_feed_rows (
  variant_id text PRIMARY KEY,
  product_id text NOT NULL,
  src text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meta_feed_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  built_at timestamptz,
  products integer NOT NULL DEFAULT 0,
  variants integer NOT NULL DEFAULT 0,
  rows integer NOT NULL DEFAULT 0,
  error text
);
INSERT INTO meta_feed_state (id) VALUES (1) ON CONFLICT DO NOTHING;
