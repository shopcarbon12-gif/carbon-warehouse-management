-- Scan-out log: every action on the Scan-out screen, with the item as it was.
--
-- The status change itself also goes to inventory_audit_logs (STATUS_CHANGE),
-- which the Status & tag logs report already reads — but that row holds only
-- the EPC and two statuses. The owner asked for "user, time, full item
-- details": what was scanned out is a sale, and a sale is looked up by item and
-- order, not by EPC. So the item is copied here as it was at the moment —
-- SKU, UPC, name, colour, size, bin — rather than joined later, when the SKU
-- may have been renamed, re-binned or archived.
--
-- action: reader_start | reader_stop | scan_out | rejected
CREATE TABLE IF NOT EXISTS scan_out_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  location_id   uuid,
  user_id       uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  action        text NOT NULL,
  epc           text,
  old_status    text,
  new_status    text,
  custom_sku_id uuid,
  sku           text,
  upc           text,
  item_name     text,
  color         text,
  size          text,
  bin           text,
  order_id      text,
  order_name    text,
  reader        text,
  rssi          integer,
  detail        text,
  CONSTRAINT scan_out_events_action_chk CHECK (action IN ('reader_start', 'reader_stop', 'scan_out', 'rejected'))
);

CREATE INDEX IF NOT EXISTS scan_out_events_tenant_time_idx ON scan_out_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scan_out_events_epc_idx ON scan_out_events (epc);
CREATE INDEX IF NOT EXISTS scan_out_events_order_idx ON scan_out_events (order_id);
