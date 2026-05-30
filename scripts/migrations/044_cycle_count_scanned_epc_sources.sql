-- Add per-EPC source tracking to cycle_count_sessions so the workspace
-- can show which scans came from which fixed reader vs the mobile
-- handheld(s), filter on it, and display per-row provenance.
--
-- Shape: `scanned_epc_sources` is a JSONB object keyed by the canonical
-- (uppercased) EPC, with one entry per first-sighting:
--
--   {
--     "F0A0B30E4F9C2780000186A1": {
--       "kind": "mobile",
--       "name": "Samsung S938U",
--       "ts":   "2026-05-30T01:48:23.521Z"
--     },
--     "F0A0B30E4F9C2780000186A2": {
--       "kind": "reader",
--       "name": "Reader-Aisle-3-North",
--       "ts":   "2026-05-30T01:49:11.012Z"
--     },
--     ...
--   }
--
-- We DO NOT replicate scanned_epcs in here — the existing string[] stays
-- canonical for "which EPCs were observed". This new column is purely
-- the source map, written by every append path alongside its scanned_epcs
-- update. Empty `{}` on existing rows (backfill migration 045 fills in
-- best-effort historical sources from cdm_reads + add_on_sessions).

ALTER TABLE cycle_count_sessions
  ADD COLUMN IF NOT EXISTS scanned_epc_sources jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Index on the source `kind` so the workspace can quickly slice
-- "mobile vs reader" without scanning the whole map per session. Reader
-- name filtering scans the per-session map (small — bounded by the
-- session's unique-EPC count, typically <50k).
CREATE INDEX IF NOT EXISTS cycle_count_sessions_scanned_epc_sources_kind_idx
  ON cycle_count_sessions
  USING gin ((scanned_epc_sources));
