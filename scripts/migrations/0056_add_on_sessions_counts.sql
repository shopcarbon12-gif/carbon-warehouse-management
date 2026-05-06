-- 2026-05-05 — O(1) ledger size on add_on_sessions.
--
-- Replaces the prior `jsonb_object_keys() COUNT(*)` pattern in submitEpc.
-- Updated atomically in the same UPDATE that mutates epc_ledger so the count
-- can never drift from the JSONB content.
ALTER TABLE add_on_sessions
  ADD COLUMN IF NOT EXISTS epc_count    INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS failed_count INT NOT NULL DEFAULT 0;
