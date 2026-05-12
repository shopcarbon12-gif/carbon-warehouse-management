-- Switch cycle_count_sessions.session_number from per-tenant to per-location.
--
-- Operators run independent counts at each warehouse / retail location and
-- want each location's counts numbered 001, 002, 003… independently. The
-- previous per-tenant numbering meant Orlando and Florida Mall shared a
-- single sequence — confusing when reviewing per-location history.
--
-- Re-backfill the existing `session_number` column per (tenant_id, location_id)
-- using started_at order. Drop the old per-tenant partial unique index and
-- create a per-(tenant_id, location_id) one.

DROP INDEX IF EXISTS cycle_count_sessions_tenant_number_uq;

WITH numbered AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, location_id
           ORDER BY started_at, id
         ) AS rn
    FROM cycle_count_sessions
)
UPDATE cycle_count_sessions s
   SET session_number = numbered.rn
  FROM numbered
 WHERE s.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS cycle_count_sessions_location_number_uq
  ON cycle_count_sessions (tenant_id, location_id, session_number)
 WHERE session_number IS NOT NULL;
