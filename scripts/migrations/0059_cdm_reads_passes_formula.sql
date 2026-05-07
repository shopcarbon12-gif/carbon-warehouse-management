-- 0059_cdm_reads_passes_formula.sql
--
-- Add `passes_formula` boolean to cdm_reads. Set per-row at insert time
-- in lib/server/cdm-agents.ts: true when the EPC decodes successfully
-- against the tenant's tenant_epc_config (i.e., it's a structurally-valid
-- Carbon-shaped tag), false otherwise.
--
-- Live scan's headline counter and the per-antenna breakdown both filter
-- on this so the operator's view of "real EPCs hitting my readers in this
-- session" is accurate without having to run the decoder at query time
-- and without writing anything to the items table. Existing rows get the
-- default false; the WHERE clause naturally excludes them since live
-- scan only counts reads from the current session anyway.
--
-- Indexed alongside read_at so the live-scan query stays cheap as
-- cdm_reads grows. Per-tenant queries already hit the
-- cdm_reads_tenant_read_at index; the partial index here narrows
-- further when we add the passes_formula filter.

ALTER TABLE cdm_reads
  ADD COLUMN IF NOT EXISTS passes_formula boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS cdm_reads_passes_formula_read_at
  ON cdm_reads (tenant_id, read_at DESC)
  WHERE passes_formula = true;
