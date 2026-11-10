-- CarbonWMS Email — wishlist emails (owner's CARBON pack 46 back in stock, 47 price drop, 48 wishlist).
-- Logged-in shoppers' wishlists are already kept in Shopify (customer metafield carbon.wishlist, written
-- by /api/wishlist). Once an hour CarbonWMS copies them here with each saved variant's price and
-- availability, so a flow can notice: a list left alone for days, a sold-out item back, a price drop.
CREATE TABLE IF NOT EXISTS public.email_wishlist_items (
  tenant_id      uuid NOT NULL,
  email          text NOT NULL,
  variant_gid    text NOT NULL,
  first_name     text NULL,
  handle         text NULL,
  title          text NULL,
  image          text NULL,
  url            text NULL,
  saved_at       timestamptz NOT NULL DEFAULT now(),
  first_price    numeric(12,2) NULL,
  last_price     numeric(12,2) NULL,
  was_available  boolean NULL,
  available      boolean NULL,
  list_changed_at timestamptz NULL,     -- when the shopper last changed the whole list (metafield updatedAt)
  checked_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, email, variant_gid)
);
CREATE INDEX IF NOT EXISTS email_wishlist_items_email_idx ON public.email_wishlist_items (tenant_id, email);
