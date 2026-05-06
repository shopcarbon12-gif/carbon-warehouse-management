-- 2026-05-05 — Add-On Count session state (multi-operator).
--
-- One row per active Add-On Count session. Lifecycle:
--   active      — at least one operator scanning
--   paused      — owner left the screen / network blip; resumes on return
--   completed   — finalised (SAVE or UPLOAD ran). Source row is also marked completed.
--   cancelled   — owner crashed / idle timeout (10 min) / explicit abort.
--
-- The unique partial index prevents two parallel sessions on the same source.
-- That index IS the row-lock — when a session lands here, a second insert
-- against the same (tenant, source_type, source_id) is rejected at DB level.
--
-- epc_ledger / failed_ledger are JSONB blobs (Q27 lock: JSONB). Shape:
--   { "<EPC_HEX_24>": { "u": "<user_uuid|null>", "d": "<device_id>", "at": "<iso8601>" } }
-- Server-mediated dedup uses these — incoming POST /epc consults epc_ledger
-- and either marks new-or-duplicate, then broadcasts via SSE.
CREATE TABLE IF NOT EXISTS add_on_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_type       TEXT NOT NULL CHECK (source_type IN ('mobile_count','cycle_count','csv_import')),
  -- Held as TEXT because device_upload_logs.id is SERIAL/INT while the other
  -- two are UUID. Resolution to typed FK happens in app code per source_type.
  source_id         TEXT NOT NULL,
  source_slip       TEXT NOT NULL,
  owner_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_device_id   TEXT,
  joined_user_ids   UUID[] NOT NULL DEFAULT '{}',
  joined_device_ids TEXT[] NOT NULL DEFAULT '{}',
  state             TEXT NOT NULL CHECK (state IN ('active','paused','completed','cancelled')) DEFAULT 'active',
  epc_ledger        JSONB NOT NULL DEFAULT '{}'::jsonb,
  failed_ledger     JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ,
  -- Filled when SAVE/UPLOAD finalises — points at the inventory_reports row
  -- that holds the audit CSV + (optional) defective CSV.
  report_id         UUID REFERENCES inventory_reports(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS add_on_sessions_tenant_state_idx
  ON add_on_sessions (tenant_id, state, last_activity_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS add_on_sessions_one_active_per_source
  ON add_on_sessions (tenant_id, source_type, source_id)
  WHERE state IN ('active','paused');
--> statement-breakpoint
-- Heartbeat-driven cleanup index — the periodic janitor scans rows where
-- last_activity_at falls behind the idle threshold and flips them to cancelled.
CREATE INDEX IF NOT EXISTS add_on_sessions_idle_idx
  ON add_on_sessions (last_activity_at)
  WHERE state IN ('active','paused');
