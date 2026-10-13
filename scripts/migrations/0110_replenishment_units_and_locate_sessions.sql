-- Store Replenishment, per unit (Locate 2.0 stage D, 2026-10-12).
-- Each physical unit (EPC) pulled for a sale line is recorded once. UNIQUE(epc)
-- is the dedupe across lines AND operators: two pickers can never count the
-- same unit, and a unit already pulled to the showroom is not offered again.
-- A line is done when its pulled units reach the sold quantity (the server then
-- writes store_replenishment_picks), or when ticked by hand as before. Stock
-- is still never changed by picking.
CREATE TABLE IF NOT EXISTS store_replenishment_units (
  id             SERIAL PRIMARY KEY,
  sale_line_id   INTEGER NOT NULL,
  sale_id        INTEGER NOT NULL,
  epc            TEXT NOT NULL UNIQUE,
  custom_sku_id  UUID NOT NULL,
  picked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_by      UUID,
  picked_by_name TEXT,
  method         TEXT
);
CREATE INDEX IF NOT EXISTS store_replenishment_units_line_idx ON store_replenishment_units (sale_line_id);

-- Locate sessions (Locate 2.0 stages C/F): one row per Locate screen use, for
-- the engine comparison and rollout gates. Timings are milliseconds from start.
CREATE TABLE IF NOT EXISTS locate_sessions (
  id              UUID PRIMARY KEY,
  tenant_id       UUID,
  location_id     UUID,
  user_id         UUID,
  device_id       TEXT,
  app_version     TEXT,
  reader_model    TEXT,
  reader_firmware TEXT,
  engine          TEXT NOT NULL,
  mode            TEXT NOT NULL,
  target_epc      TEXT,
  target_sku      TEXT,
  candidate_count INTEGER,
  started_at      TIMESTAMPTZ NOT NULL,
  ready_ms        INTEGER,
  first_seen_ms   INTEGER,
  confirmed_ms    INTEGER,
  ended_ms        INTEGER,
  outcome         TEXT,
  confirm_method  TEXT,
  confirmed_epc   TEXT,
  min_power_dbm   INTEGER,
  events          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locate_sessions_started_idx ON locate_sessions (started_at DESC);

-- 'manual' = ticked by hand on the line; 'units' = completed automatically when
-- the pulled units reached the sold quantity (undoing a unit reopens only these).
ALTER TABLE store_replenishment_picks ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual';
