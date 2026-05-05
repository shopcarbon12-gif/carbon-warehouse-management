-- 1.2.47 — multi-bin per EPC, "ADD" scope on Bin Assign.
--
-- Operator workflow: scan bin A → place 5 EPCs of SKU X. Later, scan bin
-- B → scan SKU X → choose ADD (not MOVE). Pre-1.2.47 ADD was implemented
-- as `mode='homeless_only'` on the assign endpoint, which only matched
-- items with bin_id IS NULL — items already in bin A were untouched and
-- the operator got "still in bin A" with no way to also list them in B
-- without physically relocating tags.
--
-- This column stores the SECONDARY bin assignments. `items.bin_id`
-- remains the canonical "truth bin" for qty (the operator was clear:
-- "if item in multi bin, use only 1 random bin for truth qty"). Bin
-- contents views (listBinContentsGrouped, listBinEpcs, putaway preview
-- classifier) union `bin_id = X OR X = ANY(additional_bin_ids)` so a
-- multi-bin item appears under every bin it's listed in. Reports that
-- count items keep using bin_id only — qty totals still balance.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DEFAULT '{}'::uuid[] so existing
-- rows backfill to empty array (no NULL handling required downstream).

ALTER TABLE items
  ADD COLUMN IF NOT EXISTS additional_bin_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

-- GIN index makes `X = ANY(additional_bin_ids)` lookups cheap. Most
-- items will have an empty array so the index stays small.
CREATE INDEX IF NOT EXISTS items_additional_bin_ids_gin
  ON items USING gin (additional_bin_ids);
