-- Per-order "Thank-you code" switch in the WMS order panel (default ON).
-- A row here = switched OFF for that order: printing the packing slip will not
-- create its 15%-off code, and switching off deleted the code it had.
-- Switching back ON deletes the row and creates the code at once.
CREATE TABLE IF NOT EXISTS order_thank_you_optout (
  shopify_order_id TEXT PRIMARY KEY,
  order_name       TEXT,
  opted_out_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  opted_out_by     UUID
);
