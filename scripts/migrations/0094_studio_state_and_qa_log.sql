-- Studio restructure (2026-09-29): what the judge actually said, and the
-- per-product working state so a reload does not throw away the photos, their
-- Front/Back sorting, the reviewed item spec and the "back is plain" check.
--
-- Restore point: ~/carbon-wms-backups/studio-restore-2026-09-29/RESTORE.md §5.

-- 1. The generation log recorded that QA ran, not what it found. Failures and
--    blocks were never written at all.
ALTER TABLE studio_generations
  ADD COLUMN IF NOT EXISTS qa_reasons     jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS qa_notes       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS qa_dropped     integer NOT NULL DEFAULT 0,      -- reasons filtered as confirmations / contradictions
  ADD COLUMN IF NOT EXISTS back_state     text,                            -- 'present' | 'absent' | 'unknown'
  ADD COLUMN IF NOT EXISTS spec_confirmed boolean NOT NULL DEFAULT false,  -- a human edited the spec text (false = raw analyzer output)
  ADD COLUMN IF NOT EXISTS spec_bytes     integer,
  ADD COLUMN IF NOT EXISTS error_message  text;

-- 2. Per-product Studio state. One row per matrix; overwritten on every change.
CREATE TABLE IF NOT EXISTS studio_matrix_state (
  matrix_id      uuid PRIMARY KEY,
  tenant_id      uuid,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  updated_by     uuid,
  -- [{ "url": "...", "view": "general" | "front" | "back" }, ...]
  item_refs      jsonb NOT NULL DEFAULT '[]'::jsonb,
  item_type      text,
  instruction    text,
  -- the numbered lock list, possibly edited by the operator
  item_spec      text,
  -- which photo set the spec was computed for (refViewKey on the client)
  spec_refs_key  text,
  spec_confirmed boolean NOT NULL DEFAULT false,
  -- the operator checked the real garment: the back carries nothing
  back_is_plain  boolean NOT NULL DEFAULT false
);
