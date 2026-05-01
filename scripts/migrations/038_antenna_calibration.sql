-- 038 — antenna calibration: per-(reader, antenna) "distance ↔ first-read power"
-- mapping operators record by placing a known reference tag at known distances
-- and running a power sweep against just that tag. The /antenna_test page
-- reads from this table to interpolate real feet from any RSSI/first-read-power
-- observation; without entries it falls back to the heuristic distance bucket.
--
-- IDEMPOTENT — safe to run on every container start.

CREATE TABLE IF NOT EXISTS cdm_antenna_calibration (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reader_id             uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  antenna_id            uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  /* Distance from antenna face to reference tag in FEET (decimal). */
  distance_ft           numeric(6,2) NOT NULL CHECK (distance_ft > 0),
  /* Lowest --power value (dBm × 10) at which the reference tag first read.
     100 = 10.0 dBm, 330 = 33.0 dBm. */
  first_read_power_arg  integer NOT NULL CHECK (first_read_power_arg BETWEEN 100 AND 330),
  /* Which EPC was the reference. Lets operators pick a known-stable tag and
     re-calibrate it later if the antenna moves. */
  reference_epc         text NOT NULL,
  measured_at           timestamptz NOT NULL DEFAULT now(),
  measured_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  notes                 text,
  /* Re-calibrating at the same distance overwrites the prior point cleanly. */
  UNIQUE (reader_id, antenna_id, distance_ft)
);

CREATE INDEX IF NOT EXISTS idx_cdm_antenna_calibration_lookup
  ON cdm_antenna_calibration (reader_id, antenna_id);

CREATE INDEX IF NOT EXISTS idx_cdm_antenna_calibration_tenant
  ON cdm_antenna_calibration (tenant_id);

-- Sanity: tenant_id should match the antenna's tenant via reader → location
-- → tenant. Enforced at API level (not in CHECK) since the relationship
-- crosses 3 hops. Foreign keys cascade-delete from devices, so an antenna
-- removal also drops its calibration points.
