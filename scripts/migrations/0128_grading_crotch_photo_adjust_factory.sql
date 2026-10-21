-- CarbonGradingAI 1.0.7 (owner 2026-10-20):
--  * bottoms take a second "crotch photo" (legs spread) for the rise and inseam;
--  * lines can be adjusted on the WMS (Scan review › Adjust lines);
--  * accuracy checks keep their photo and corners so they can be checked on the desktop;
--  * a product's factory size sheet, to flag readings far from it (warning only).
ALTER TABLE size_grading_scans
  ADD COLUMN IF NOT EXISTS crotch           jsonb,   -- {pxPerCm, photoW, photoH, lines, aiLines, outlineLines, depth}
  ADD COLUMN IF NOT EXISTS crotch_photo_key text,
  ADD COLUMN IF NOT EXISTS adjusted_at      timestamptz,
  ADD COLUMN IF NOT EXISTS adjusted_by      uuid REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE grading_accuracy_checks
  ADD COLUMN IF NOT EXISTS photo_key  text,
  ADD COLUMN IF NOT EXISTS corners    jsonb,          -- [[x,y] TL, TR, BR, BL] in photo pixels
  ADD COLUMN IF NOT EXISTS px_per_cm  numeric(10, 4),
  ADD COLUMN IF NOT EXISTS photo_w    integer,
  ADD COLUMN IF NOT EXISTS photo_h    integer;

-- One row per product and size: the factory's numbers (cm), as typed from its sheet.
CREATE TABLE IF NOT EXISTS size_grading_factory_specs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  matrix_id   uuid NOT NULL REFERENCES matrices(id) ON DELETE CASCADE,
  size        text NOT NULL,
  points_cm   jsonb NOT NULL,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS size_grading_factory_specs_uq ON size_grading_factory_specs (matrix_id, upper(trim(size)));
