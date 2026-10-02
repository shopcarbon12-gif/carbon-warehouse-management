-- Measurements taken on the Size Grading page, saved against the exact SKU.
--
-- Keyed on custom_sku_id, not on the matrix: a measurement only means something
-- alongside the size it was taken on, and that pairing is what custom_skus
-- already is. Everything else about the item — UPC, product name, colour —
-- hangs off that row, so nothing is copied here that could drift from it.
--
-- The points of measure are a jsonb map rather than columns because they differ
-- by garment: a top has chest/length/hem/shoulder/sleeve, trousers have
-- waist/hip/inseam/outseam/leg opening/rise. Adding a garment family should not
-- need a migration.
--
-- Centimetres throughout. Inches are a presentation choice and are derived, so
-- there is one number per measurement and no chance of the two disagreeing.

CREATE TABLE IF NOT EXISTS size_grading_measurements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  custom_sku_id  uuid NOT NULL REFERENCES custom_skus(id) ON DELETE CASCADE,
  -- top | trousers | shorts | dress | skirt, as detected or corrected on the page
  garment_type   text NOT NULL,
  -- { "chest": 52.0, "length": 71.0, ... } in centimetres
  points_cm      jsonb NOT NULL,
  -- px-per-cm the photo was calibrated at, so a suspect reading can be judged later
  px_per_cm      numeric(10, 4),
  -- whether the operator corrected the detected garment type
  type_overridden boolean NOT NULL DEFAULT false,
  measured_at    timestamptz NOT NULL DEFAULT now(),
  measured_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  note           text
);

-- The page shows the most recent measurement for a SKU, and history is kept
-- rather than overwritten: a garment remeasured after a production change is a
-- fact worth keeping, not a correction to the old one.
CREATE INDEX IF NOT EXISTS size_grading_measurements_sku_idx
  ON size_grading_measurements (custom_sku_id, measured_at DESC);
