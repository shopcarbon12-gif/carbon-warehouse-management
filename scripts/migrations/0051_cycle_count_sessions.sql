-- 2026-05-05 — cycle_count_sessions
--
-- Persistent state for cycle counts so operators can:
--   - pause a multi-hour count and resume later (status: paused → active)
--   - revisit historical counts (status: committed | canceled) for audit
--   - have two operators count different bins of the same warehouse without
--     racing on a single in-memory state (one active session per location+bin)
--
-- Lifecycle:
--   active      — scanning in progress; scanned_epcs appended live
--   paused      — operator stepped away; can resume by flipping back to active
--   committed   — variance applied to items table; immutable after this point
--   canceled    — abandoned; no DB changes applied to items
--
-- A row is rejected if another row exists for the same tenant/location/bin
-- in (active, paused). Once committed/canceled the conflict clears so a
-- new session can be opened.
CREATE TABLE IF NOT EXISTS cycle_count_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  location_id       UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  bin_id            UUID REFERENCES bins(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active','paused','committed','canceled')),
  started_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  -- Snapshot of expected (in-stock) EPCs at session start. Frozen so a
  -- count that started Monday can be committed Tuesday against Monday's
  -- baseline, even if other workflows changed item state in between.
  expected_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Live array of unique scanned EPCs.
  scanned_epcs      JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Optional reader-id filter — empty = accept all readers.
  reader_filter     JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Free-form note attached on commit (auditor name, ticket #, etc).
  notes             TEXT,
  -- Variance + audit_log id stamped at commit time.
  variance_summary  JSONB,
  audit_log_id      UUID REFERENCES audit_log(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cycle_count_sessions_tenant_status_idx
  ON cycle_count_sessions (tenant_id, status, started_at DESC);

CREATE INDEX IF NOT EXISTS cycle_count_sessions_location_open_idx
  ON cycle_count_sessions (tenant_id, location_id, COALESCE(bin_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status IN ('active','paused');

-- Stop two operators starting overlapping sessions on the same scope.
-- Treat NULL bin_id as "all bins of the location" — distinct from any
-- specific bin, so an all-location session and a single-bin session at
-- the same location ARE allowed to coexist (they're complementary).
CREATE UNIQUE INDEX IF NOT EXISTS cycle_count_sessions_one_open_per_scope
  ON cycle_count_sessions (
    tenant_id,
    location_id,
    COALESCE(bin_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status IN ('active','paused');

CREATE OR REPLACE FUNCTION cycle_count_sessions_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cycle_count_sessions_touch ON cycle_count_sessions;
CREATE TRIGGER cycle_count_sessions_touch
  BEFORE UPDATE ON cycle_count_sessions
  FOR EACH ROW EXECUTE FUNCTION cycle_count_sessions_touch_updated_at();
