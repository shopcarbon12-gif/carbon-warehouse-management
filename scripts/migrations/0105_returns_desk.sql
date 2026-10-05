-- Returns handled in the WMS (owner, 2026-10-05): after a return is approved in
-- Shopify, the returned pieces are scanned in (SOLD/UNKNOWN → LIVE), the
-- exchange pieces scanned out, and the WMS completes the return in Shopify.

-- Scan-ins share the Scan-out log, with the return they belong to.
ALTER TABLE scan_out_events ADD COLUMN IF NOT EXISTS return_id text;
ALTER TABLE scan_out_events ADD COLUMN IF NOT EXISTS return_name text;
ALTER TABLE scan_out_events DROP CONSTRAINT IF EXISTS scan_out_events_action_chk;
ALTER TABLE scan_out_events
  ADD CONSTRAINT scan_out_events_action_chk
  CHECK (action IN ('reader_start', 'reader_stop', 'scan_out', 'rejected', 'undo', 'scan_in'));
CREATE INDEX IF NOT EXISTS scan_out_events_return_idx ON scan_out_events (return_id);

-- Exchange pieces already scanned out when the WMS released them: the
-- returns/process webhook must not mark more tags for them.
ALTER TABLE shopify_exchange_marks ADD COLUMN IF NOT EXISTS scanned_qty integer NOT NULL DEFAULT 0;

-- Returned pieces already scanned in: the dispose webhook uses these before
-- touching any other tag of the order.
ALTER TABLE shopify_return_restocks ADD COLUMN IF NOT EXISTS credit_used integer NOT NULL DEFAULT 0;

-- A return approved in Shopify (owner, 2026-10-05): its exchange items get one
-- LIVE tag each marked UNKNOWN, and its returned pieces' tags go IN TRANSIT
-- until they are scanned in. One row per return makes that happen once.
CREATE TABLE IF NOT EXISTS shopify_return_approvals (
  return_id    text PRIMARY KEY,
  order_id     text NOT NULL,
  return_name  text,
  in_transit   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shopify_return_approvals_order_idx ON shopify_return_approvals (order_id);
