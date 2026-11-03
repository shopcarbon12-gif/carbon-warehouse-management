-- Meta Shop photos (owner 2026-11-03): the Facebook / Instagram Shop showed one
-- old picture per product while Shopify had the full new gallery. The
-- supplementary feed now carries every variant (not only those with a close-up)
-- with its colour's whole Shopify gallery as additional pictures.
-- src = the close-up (NULL when the colour has none: Shopify's own main picture is sent).
ALTER TABLE meta_feed_rows ALTER COLUMN src DROP NOT NULL;
ALTER TABLE meta_feed_rows ADD COLUMN IF NOT EXISTS main text NULL;
ALTER TABLE meta_feed_rows ADD COLUMN IF NOT EXISTS gallery text[] NOT NULL DEFAULT '{}';
