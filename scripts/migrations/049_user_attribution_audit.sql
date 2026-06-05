-- 049_user_attribution_audit.sql
--
-- User attribution foundation: every handheld action must record WHO did it so
-- reports can render the actor as "First L." (users.first_name + last-initial).
--
--   1. encode_events gets a created_by (chips were unattributed).
--   2. New per-action audit tables, each with created_by → users(id):
--        print_events     · label prints (RFID + non-RFID)
--        status_changes   · status transitions (drives Status Change + Damages)
--        bin_events       · putaway assign + clean-bin clear
--        locate_events    · Geiger + Cloud locate
--        lookup_events    · Item Lookup history
--
-- All tenant/location-scoped and indexed by (tenant_id, created_at DESC) so the
-- report list queries stay fast. gen_random_uuid() is built-in on PG13+.

-- 1. Encode / re-encode attribution -------------------------------------------
ALTER TABLE encode_events
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES users(id);

-- 2. Label prints --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS print_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid,
  kind          text NOT NULL,                 -- 'rfid' | 'non_rfid'
  epc           text,
  custom_sku_id uuid,
  sku           text,
  qty           integer NOT NULL DEFAULT 1,
  template      text,
  printer       text,
  device_id     text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS print_events_tenant_created_idx
  ON print_events (tenant_id, created_at DESC);

-- 3. Status changes (+ damages subset) ----------------------------------------
CREATE TABLE IF NOT EXISTS status_changes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid,
  epc           text NOT NULL,
  custom_sku_id uuid,
  sku           text,
  old_status    text,
  new_status    text NOT NULL,
  reason        text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS status_changes_tenant_created_idx
  ON status_changes (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS status_changes_damaged_idx
  ON status_changes (tenant_id, created_at DESC)
  WHERE new_status = 'damaged';

-- 4. Bin events (putaway assign / clean-bin clear) ----------------------------
CREATE TABLE IF NOT EXISTS bin_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  location_id   uuid,
  action        text NOT NULL,                 -- 'assign' | 'clear'
  bin_code      text,
  epc           text,
  custom_sku_id uuid,
  sku           text,
  epc_count     integer,                       -- clear: how many were cleared
  mode          text,                          -- 'scan' | 'manual'
  device_id     text,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bin_events_tenant_created_idx
  ON bin_events (tenant_id, created_at DESC);

-- 5. Locate events (Geiger + Cloud) -------------------------------------------
CREATE TABLE IF NOT EXISTS locate_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  location_id      uuid,
  source           text NOT NULL,              -- 'geiger' | 'cloud'
  target_sku       text,
  target_epc       text,
  found            boolean,
  peak_rssi        integer,
  sent_from_user_id uuid REFERENCES users(id), -- cloud: who pushed from web
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locate_events_tenant_created_idx
  ON locate_events (tenant_id, created_at DESC);

-- 6. Lookup events (Item Lookup history) --------------------------------------
CREATE TABLE IF NOT EXISTS lookup_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  location_id uuid,
  query       text NOT NULL,
  query_type  text,                            -- 'EPC' | 'UPC' | 'SKU'
  sku_found   text,
  name_found  text,
  on_hand     integer,
  bin_code    text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookup_events_tenant_created_idx
  ON lookup_events (tenant_id, created_at DESC);
