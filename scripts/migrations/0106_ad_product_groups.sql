-- Ad product groups (owner, 2026-10-11): named lists of products that ad
-- campaigns advertise. "Sync ads" (Integrations → Shopify) keeps each group
-- current in Google Merchant Center (as a custom label any Google campaign can
-- filter on) and in Meta (as a catalog product set any Meta ad set can use).
-- A new campaign only needs a group — define it here, press Sync ads.
--
-- Rules: a product belongs when its Shopify product type is in product_types OR
-- its title contains one of name_contains, and its title contains none of
-- name_excludes. include_groups adds every product of the listed groups.
CREATE TABLE IF NOT EXISTS ad_product_groups (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  product_types      jsonb NOT NULL DEFAULT '[]'::jsonb,
  name_contains      jsonb NOT NULL DEFAULT '[]'::jsonb,
  name_excludes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  include_groups     jsonb NOT NULL DEFAULT '[]'::jsonb,
  in_stock_only      boolean NOT NULL DEFAULT true,
  -- Google: custom label slot (0-4) and value written on member listings.
  google_label_slot  smallint CHECK (google_label_slot BETWEEN 0 AND 4),
  google_label_value text,
  -- Meta: product set name (created if meta_set_id is empty).
  meta_set_name      text,
  meta_set_id        text,
  active             boolean NOT NULL DEFAULT true,
  sort_order         integer NOT NULL DEFAULT 0,
  last_sync          jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- The groups the 2026-10-11 Google Shopping + Meta catalog campaigns were
-- built on (same rules, same label values, same Meta set ids).
INSERT INTO ad_product_groups
  (slug, name, product_types, name_contains, name_excludes, include_groups,
   google_label_slot, google_label_value, meta_set_name, meta_set_id, sort_order)
VALUES
  ('summer-men', 'Men summer',
   '["MEN >> T-SHIRT","MEN >> T- SHIRT","MEN >> TANK TOP","MEN >> SHORTS","MEN >> BUTTON SHIRT","MEN >> SWIMWEAR","MEN >> TOP"]',
   '["Mens Denim Shorts","Jay Denim Shorts","Kai Denim Shorts","Palm Top Set","Palm Shorts Set","Ryland","73 T-Shirt Set"]',
   '["sweater","Lucas Shirt","Texture Top"]', '[]',
   0, 'summer-men', 'Ads · Men summer (in stock)', '2094180851207988', 10),
  ('summer-women', 'Women dresses & sets',
   '["WOMEN >> DRESS","DRESS","SET"]',
   '["Alia Shorts Set","Nice Top Set","Nice Shorts Set","Karina Crop Set","Natalie Top Set","Natalie Bottom Set","Christy Crop Set","Christy Legging Set"]',
   '[]', '[]',
   0, 'summer-women', 'Ads · Women dresses & sets (in stock)', '1613703017098497', 20),
  ('summer-all', 'Summer men + women',
   '[]', '[]', '[]', '["summer-men","summer-women"]',
   NULL, NULL, 'Ads · Summer men + women (in stock)', '1638240954375812', 30)
ON CONFLICT (slug) DO NOTHING;
