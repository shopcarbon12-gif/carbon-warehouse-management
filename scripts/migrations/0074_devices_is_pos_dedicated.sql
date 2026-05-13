-- POS-dedicated readers — flag fixed-reader rows whose reads are owned
-- exclusively by the companion POS app (Carbon-POS at localhost:5000 in
-- dev, dedicated subdomain in prod). These readers must NOT appear in
-- WMS pickers (Operations dashboard, Bulk Status, Transfer In, etc.)
-- and their reads must NOT inflate the dashboard Live Scan counter.
--
-- Admin surfaces (Hardware Config) and Cycle Counts still see them
-- because operators need physical control over every reader regardless
-- of who consumes the EPCs.
--
-- The reader at 192.168.1.69 (Orlando Warehouse / "POS") is back-filled
-- as is_pos_dedicated=TRUE here. Future POS readers are flagged via a
-- checkbox in the Reader Editor modal.

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS is_pos_dedicated BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS devices_pos_dedicated_idx
  ON devices (tenant_id, is_pos_dedicated)
 WHERE is_pos_dedicated = TRUE;

UPDATE devices
   SET is_pos_dedicated = TRUE
 WHERE device_type = 'fixed_reader'
   AND network_address ILIKE '%192.168.1.69%';
