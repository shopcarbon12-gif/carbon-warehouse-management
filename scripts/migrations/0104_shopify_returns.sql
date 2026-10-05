-- Shopify returns and exchanges → WMS tag statuses (lib/server/shopify-returns.ts).
--
-- An exchange adds new items to an order without a new order, so orders/paid
-- never fires for them: the WMS kept counting them LIVE and its 5-minute stock
-- push could undo Shopify's reservation. Returned items came back as SOLD until
-- a cycle count found them. These two tables make both webhooks idempotent and
-- record which tags each one changed.

-- One row per Shopify ExchangeLineItem: how many of its items have had a LIVE
-- tag marked UNKNOWN, and which tags. A re-delivered or partial "process"
-- only marks the difference.
CREATE TABLE IF NOT EXISTS shopify_exchange_marks (
  exchange_line_item_id text PRIMARY KEY,
  order_id      text NOT NULL,
  return_id     text NOT NULL,
  return_name   text,
  variant_id    text,
  sku           text,
  custom_sku_id uuid,
  marked_qty    integer NOT NULL DEFAULT 0,
  shortfall     integer NOT NULL DEFAULT 0,
  epcs          text[] NOT NULL DEFAULT '{}',
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopify_exchange_marks_order_idx ON shopify_exchange_marks (order_id);

-- One row per reverse-fulfillment disposition (Shopify's record of what was
-- done with returned items). RESTOCKED ones put this order's tags back to LIVE.
CREATE TABLE IF NOT EXISTS shopify_return_restocks (
  disposition_id text PRIMARY KEY,
  order_id       text NOT NULL,
  return_id      text,
  sku            text,
  disposition    text NOT NULL,
  quantity       integer NOT NULL,
  restored       integer NOT NULL DEFAULT 0,
  epcs           text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopify_return_restocks_order_idx ON shopify_return_restocks (order_id);
