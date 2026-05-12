-- 2026-05-12 — Persist live-scan session history.
--
-- The in-memory `live-scan-sessions` map only tracks the CURRENTLY-ACTIVE
-- session. To show "Last Live Scan: N EPCs" on the dashboard after the
-- Live Scan widget moves to Hardware Config, we need a historical record
-- that survives server restarts.
--
-- One row per completed session — written when endSession() is called
-- OR when the auto-expire prune drops a stale session.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'live_scan_sessions'
  ) THEN RETURN; END IF;

  CREATE TABLE live_scan_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    location_id     UUID,
    started_by      UUID,
    started_at      TIMESTAMPTZ NOT NULL,
    ended_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    unique_epc_count INTEGER NOT NULL DEFAULT 0,
    end_reason      TEXT NOT NULL DEFAULT 'stopped'
  );

  CREATE INDEX live_scan_sessions_tenant_ended_at
    ON live_scan_sessions (tenant_id, ended_at DESC);
  CREATE INDEX live_scan_sessions_location_ended_at
    ON live_scan_sessions (location_id, ended_at DESC) WHERE location_id IS NOT NULL;
END $$;
