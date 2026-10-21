-- Visitor alerts (owner 2026-10-21): phone/computer notifications from
-- Shopify → Visitors, like Tawk.to's — with the Carbon logo, kept until
-- dismissed. Four kinds, each a switch per device in Settings › Alerts:
--   visitor_new      someone new is on the store          (on by default)
--   visitor_back     a returning / named visitor is back   (on by default)
--   visitor_checkout someone started checkout              (on by default)
--   visitor_cart     someone added to cart                 (off by default)

ALTER TABLE web_push_subscriptions
  ALTER COLUMN kinds SET DEFAULT ARRAY['orders', 'studio', 'visitor_new', 'visitor_back', 'visitor_checkout'];

-- Devices already signed up get the three default visitor alerts (once).
UPDATE web_push_subscriptions
   SET kinds = kinds || ARRAY['visitor_new', 'visitor_back', 'visitor_checkout']::text[], updated_at = now()
 WHERE NOT (kinds && ARRAY['visitor_new', 'visitor_back', 'visitor_checkout', 'visitor_cart']::text[]);

-- One alert per visitor, per visit, per kind — and the hourly flood cap counts these.
CREATE TABLE IF NOT EXISTS visitor_alerts (
  visitor_id text NOT NULL,
  visit integer NOT NULL,
  kind text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, visit, kind)
);
CREATE INDEX IF NOT EXISTS visitor_alerts_at_idx ON visitor_alerts (at DESC);
