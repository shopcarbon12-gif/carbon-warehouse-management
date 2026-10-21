-- Visitors (Shopify → Visitors, owner 2026-10-21): who is on shopcarbon.com
-- right now and what every real visitor did — pages, cart adds, checkout,
-- signups, orders — kept after they leave (unlike the Tawk.to monitor).
-- Real people only: Carbon Shield's verdict decides (bots and crawlers are
-- never written here). No screen recording, nothing typed into forms.
-- Store-level (one Shopify store), so no tenant.

-- One row per browser (Carbon Shield's first-party cs_vid cookie).
CREATE TABLE IF NOT EXISTS visitors (
  visitor_id text PRIMARY KEY,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  -- A new visit starts after 30 minutes without a page view.
  visits integer NOT NULL DEFAULT 1,
  page_views integer NOT NULL DEFAULT 0,
  ip text,
  country text,
  asn integer,
  network text,
  device text,      -- phone / tablet / computer
  os text,
  browser text,
  first_source text,
  first_ad text,
  landing_path text,
  last_source text,
  last_path text,
  last_title text,
  -- Known once they log in (signed by Shopify's Liquid), sign up for emails,
  -- or place an order.
  customer_id text,
  customer_name text,
  email text,
  cart_adds integer NOT NULL DEFAULT 0,
  checkouts integer NOT NULL DEFAULT 0,
  orders integer NOT NULL DEFAULT 0,
  revenue numeric(12, 2) NOT NULL DEFAULT 0,
  -- The owner's own label and note (WMS → Shopify → Visitors).
  nickname text,
  note text,
  labelled_at timestamptz,
  labelled_by_email text
);
CREATE INDEX IF NOT EXISTS visitors_last_seen_idx ON visitors (last_seen DESC);
CREATE INDEX IF NOT EXISTS visitors_email_idx ON visitors (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS visitors_customer_idx ON visitors (customer_id) WHERE customer_id IS NOT NULL;

-- What each visitor did, in order. Kept 90 days (worker).
CREATE TABLE IF NOT EXISTS visitor_events (
  id bigserial PRIMARY KEY,
  visitor_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  visit integer NOT NULL DEFAULT 1,
  kind text NOT NULL CHECK (kind IN ('view', 'cart_add', 'checkout', 'signup', 'order')),
  path text,
  title text,
  source text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS visitor_events_visitor_at_idx ON visitor_events (visitor_id, at);
CREATE INDEX IF NOT EXISTS visitor_events_at_idx ON visitor_events (at DESC);
