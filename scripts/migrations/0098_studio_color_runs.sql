-- Studio "generate another colour" (2026-10-02): the same garment, rendered in
-- a colourway we have one photo of.
--
-- The product analysis is per MATRIX and stays that way — construction, text,
-- hardware placement and the zone map do not change with the dye. What changes
-- is per COLOUR: the single reference photo of that colourway, the colour name
-- the render must hit, and the variation seed.
--
-- The seed is stored rather than derived from the clock because the whole point
-- is that two colourways must not come back in the same poses with the same
-- face. A stored, per-colour seed makes "different from the other colours"
-- repeatable instead of a coin toss, and keeps a regenerate of one colour
-- landing where it did before.
--
-- Keyed on (matrix_id, color), NOT on the UPC: matrices.upc is not unique and
-- the same SKU lives in several matrices, so a UPC key would blend two
-- products' photos together.
--
-- Restore point: ~/carbon-wms-backups/studio-restore-2026-09-29/RESTORE.md §5.

CREATE TABLE IF NOT EXISTS studio_color_runs (
  matrix_id       uuid        NOT NULL,
  -- The variant colour label as the catalogue spells it ("BLACK", "NAVY").
  -- Trimmed, case preserved; matched case-insensitively by the API.
  color           text        NOT NULL,
  tenant_id       uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      uuid,
  -- The ONE photo of this colourway (upload or phone hand-off).
  color_ref_url   text,
  -- What the render must hit, e.g. "deep navy blue". Named by the colour check
  -- and correctable by the operator, because a phone photo under warm light
  -- reads several shades off.
  color_name      text,
  -- Anything the colour check saw that contradicts the matrix spec — most often
  -- hardware finish, e.g. a black zip on black where the grey carries silver.
  hardware_note   text,
  -- Rotates pose/expression variation away from the other colourways.
  variation_seed  integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (matrix_id, color)
);

CREATE INDEX IF NOT EXISTS studio_color_runs_matrix_idx
  ON studio_color_runs (matrix_id);
