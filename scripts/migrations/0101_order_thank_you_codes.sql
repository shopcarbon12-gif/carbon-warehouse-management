-- Thank-you codes: printing an order's packing slip in the WMS creates one
-- Shopify discount code for that order — 15% off the customer's next order,
-- single use, locked to that customer, valid until 45 days after purchase.
-- One row per order (a reprint reuses it). Carbon Rewards (rewards.shopcarbon.com)
-- reads active rows by shopify_customer_gid and shows them, copyable, on the
-- customer's Rewards page. used_at is set by the WMS orders/paid webhook when an
-- order arrives carrying the code.
CREATE TABLE IF NOT EXISTS order_thank_you_codes (
  id                   SERIAL PRIMARY KEY,
  shopify_order_id     TEXT NOT NULL UNIQUE,
  order_name           TEXT NOT NULL,
  shopify_customer_gid TEXT NOT NULL,
  code                 TEXT NOT NULL UNIQUE,
  discount_gid         TEXT NOT NULL,
  percent_off          INTEGER NOT NULL,
  ends_at              TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           UUID,
  used_at              TIMESTAMPTZ,
  used_order_name      TEXT
);

CREATE INDEX IF NOT EXISTS order_thank_you_codes_customer_idx
  ON order_thank_you_codes (shopify_customer_gid, ends_at DESC);
