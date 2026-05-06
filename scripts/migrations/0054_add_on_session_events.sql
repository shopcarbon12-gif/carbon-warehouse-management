-- 2026-05-05 — Append-only audit log for Add-On Count session events.
--
-- Two purposes:
--  1. Audit trail — Q29 lock: prior Add-On's results survive as append-only
--     history. When super-admin re-opens a completed source, the new session
--     starts with a fresh ledger but the old session's events stay queryable.
--  2. SSE replay — when a joined device reconnects after a brief drop, it
--     fetches events with id > last_seen_event_id to catch up before
--     re-subscribing to the live stream.
CREATE TABLE IF NOT EXISTS add_on_session_events (
  id           BIGSERIAL PRIMARY KEY,
  session_id   UUID NOT NULL REFERENCES add_on_sessions(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  device_id    TEXT,
  event_type   TEXT NOT NULL CHECK (event_type IN (
    'started','joined','join_requested','join_approved','join_declined',
    'epc_new','epc_duplicate','epc_failed',
    'paused','resumed','signed_out','heartbeat','completed','cancelled'
  )),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS add_on_session_events_session_idx
  ON add_on_session_events (session_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS add_on_session_events_tenant_created_idx
  ON add_on_session_events (tenant_id, created_at DESC);
