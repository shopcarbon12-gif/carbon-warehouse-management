-- Idempotency + audit ledger for Shopify sale reconciliation.
--
-- Each Shopify orders/paid webhook is processed exactly once (order_id PK, an
-- INSERT ... ON CONFLICT DO NOTHING claims it). We record what the sale did:
-- for RFID SKUs it flips the oldest N in-stock EPCs to `unknown`; for manual
-- SKUs it decrements manual_item_qty. `detail` keeps the SKUs/qty and the EPCs
-- flipped, so a sale is fully traceable.

CREATE TABLE IF NOT EXISTS shopify_sale_events (
  order_id            text PRIMARY KEY,
  order_name          text,
  processed_at        timestamptz NOT NULL DEFAULT now(),
  line_count          int,
  flipped_unknown     int DEFAULT 0,
  manual_decremented  int DEFAULT 0,
  detail              jsonb
);
