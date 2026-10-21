-- CarbonGradingAI 1.0.6: accuracy checks against a rigid object of known size
-- (a printed target, a board, a tile). Diagnostic only — the phone never
-- corrects its scale from these; they are kept so a drift shows over time.
CREATE TABLE IF NOT EXISTS grading_accuracy_checks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  true_w_cm         numeric(8, 2) NOT NULL,
  true_h_cm         numeric(8, 2) NOT NULL,
  measured_w_cm     numeric(8, 2) NOT NULL,
  measured_h_cm     numeric(8, 2) NOT NULL,
  measured_diag_cm  numeric(8, 2) NOT NULL,
  -- depth age, high-confidence %, plane RMS, inliers, tilt, distance, px/cm
  depth             jsonb,
  app_version       text,
  device_model      text,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS grading_accuracy_checks_created_idx ON grading_accuracy_checks (created_at DESC);
