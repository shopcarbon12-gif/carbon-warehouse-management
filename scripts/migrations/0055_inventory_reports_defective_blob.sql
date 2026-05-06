-- 2026-05-05 — Defective-CSV attachment on inventory_reports rows.
--
-- When SAVE or UPLOAD on Add-On Count (or Count) finalises, the server runs
-- per-EPC system-id validation. EPCs that fail (bad_length, bad_hex,
-- wrong_prefix, bad_config, unknown_system_id) get tag_killed AND recorded
-- into a CSV that's attached to the report row. The Defective EPCs modal
-- already surfaces these via items.status='tag_killed'; this column lets the
-- Reports page link directly to the per-session defective CSV.
ALTER TABLE inventory_reports
  ADD COLUMN IF NOT EXISTS defective_csv_blob   TEXT,
  ADD COLUMN IF NOT EXISTS defective_row_count  INT NOT NULL DEFAULT 0;
