-- Search & Encode support: case-insensitive Custom SKU lookup, per-warehouse serial counter,
-- encode_events audit log. Requires 003_standardize_lightspeed_terms.sql applied.

CREATE INDEX IF NOT EXISTS custom_skus_sku_lower_idx
  ON custom_skus (LOWER(sku));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rfid_serial_counters (
  warehouse_id varchar(64) PRIMARY KEY,
  current_serial bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS encode_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  old_epc varchar(96),
  new_epc varchar(96),
  system_id bigint,
  serial bigint,
  custom_sku varchar(128),
  warehouse_id varchar(64),
  device_id varchar(128),
  status varchar(32) NOT NULL DEFAULT 'ok',
  encoded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS encode_events_new_epc_idx ON encode_events (new_epc);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS encode_events_warehouse_encoded_at_idx
  ON encode_events (warehouse_id, encoded_at DESC);
