-- Front and back are two different measurements of the same garment.
--
-- Some points only exist on one side: the back rise of a pair of trousers is
-- not the front rise, and a back neck drop has no front equivalent. Others —
-- chest, hem, leg opening — appear on both, and having the pair is a free
-- cross-check: the two should agree within a few millimetres, and when they do
-- not, something was folded, creased or shot at an angle.
--
-- Stored as a column rather than as a prefix on every point name, so a reading
-- can be looked up by side without string matching, and so the existing rows —
-- all of them taken from the front — stay correct with a default rather than a
-- backfill.

ALTER TABLE size_grading_measurements
  ADD COLUMN IF NOT EXISTS view text NOT NULL DEFAULT 'front';

ALTER TABLE size_grading_measurements
  DROP CONSTRAINT IF EXISTS size_grading_measurements_view_chk;
ALTER TABLE size_grading_measurements
  ADD CONSTRAINT size_grading_measurements_view_chk CHECK (view IN ('front', 'back'));

-- The card asks for "the latest front" and "the latest back" separately, so the
-- side belongs in the index ahead of the timestamp.
DROP INDEX IF EXISTS size_grading_measurements_sku_idx;
CREATE INDEX IF NOT EXISTS size_grading_measurements_sku_view_idx
  ON size_grading_measurements (custom_sku_id, view, measured_at DESC);
