-- Idempotency + audit ledger for Shopify refund reconciliation — the inverse
-- of 0081.
--
-- orders/paid flips a sale's tags to `unknown` (RFID) or decrements
-- manual_item_qty (manual). When Shopify refunds that order and restocks the
-- items, it puts the quantity back on its side; without this, the WMS stayed
-- short until the next cycle count happened to scan the tags.
--
-- One row per Shopify refund (refund_id PK, an INSERT ... ON CONFLICT DO
-- NOTHING claims it). An order can be refunded in several partial refunds, so
-- rows are also looked up by order_id: each refund may only undo what earlier
-- refunds of the same order have not already undone. `detail` records the
-- EPCs restored and anything deliberately left alone.

CREATE TABLE IF NOT EXISTS shopify_refund_events (
  refund_id           text PRIMARY KEY,
  order_id            text NOT NULL,
  order_name          text,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  restored_in_stock   int DEFAULT 0,
  manual_incremented  int DEFAULT 0,
  detail              jsonb
);

CREATE INDEX IF NOT EXISTS shopify_refund_events_order_id_idx
  ON shopify_refund_events (order_id);
