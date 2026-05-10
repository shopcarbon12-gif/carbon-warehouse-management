-- Per-tenant monotonic session number for cycle_count_sessions.
--
-- Operators want each count to carry a sequential "#" they can reference
-- (e.g. "count #1, #2, #3…") instead of remembering UUIDs or auto-named
-- timestamps. Numbering is per-tenant — each tenant counts independently
-- starting from 1.
--
-- Implementation: a plain INT column on cycle_count_sessions stamped at
-- INSERT time via `COALESCE(MAX(session_number),0)+1` scoped to the
-- tenant. Cycle counts are operator-driven (one open session at a time
-- per location/bin scope) and low-volume; the rare race window where two
-- sessions could collide on the same number is acceptable, and the
-- partial unique index below makes a duplicate fail loudly so the caller
-- can retry.
--
-- Backfill: existing rows get numbered in started_at order so historical
-- sessions show as #1, #2, #3… in the audit-facing history table.

ALTER TABLE cycle_count_sessions
  ADD COLUMN IF NOT EXISTS session_number INT;

-- Backfill: number existing rows in chronological order, per tenant.
WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id
           ORDER BY started_at, id
         ) AS rn
    FROM cycle_count_sessions
   WHERE session_number IS NULL
)
UPDATE cycle_count_sessions s
   SET session_number = numbered.rn
  FROM numbered
 WHERE s.id = numbered.id;

-- Enforce uniqueness per tenant. Allow NULL during the window between
-- INSERT and the stamp (in practice we stamp synchronously, but the
-- index needs to permit it).
CREATE UNIQUE INDEX IF NOT EXISTS cycle_count_sessions_tenant_number_uq
  ON cycle_count_sessions (tenant_id, session_number)
 WHERE session_number IS NOT NULL;
