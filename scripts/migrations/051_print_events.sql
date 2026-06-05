-- 051_print_events.sql
-- Label Print report needs a print log. (050 dropped the empty placeholder;
-- this is the real one, written by the handheld /api/handheld/print-event POST
-- after each successful print.)
CREATE TABLE IF NOT EXISTS print_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid,
  kind          text NOT NULL,            -- 'rfid' | 'non_rfid'
  epc           text,
  custom_sku_id uuid,
  sku           text,
  item_name     text,
  qty           integer NOT NULL DEFAULT 1,
  template      text,
  printer       text,
  device_id     text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS print_events_tenant_created_idx
  ON print_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS print_events_kind_idx
  ON print_events (tenant_id, kind, created_at DESC);
