-- Per-agent live_scan state — so a per-store cashier can toggle ONLY
-- that store's reader without affecting other stores' readers (or being
-- affected by the tenant-wide dashboard mass-toggle).
--
-- Resolution rule in getAgentConfigBundle (lib/server/cdm-agents.ts):
--   If live_scan_last_started_at IS NULL → fall back to the tenant-wide
--   in-memory live-scan session (the existing dashboard mass-toggle).
--   If live_scan_last_started_at IS NOT NULL → the agent has been
--   individually managed; use its own live_scan_active value.
--
-- This preserves back-compat: untouched agents continue to follow the
-- tenant-wide dashboard. The moment a POS app (or any caller) hits
-- POST /api/cdm-agents/[id]/live-scan/start, that agent diverges and
-- only its own per-agent endpoint can change it from there on.

ALTER TABLE cdm_agents
  ADD COLUMN IF NOT EXISTS live_scan_active BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS live_scan_last_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS live_scan_started_by UUID;
