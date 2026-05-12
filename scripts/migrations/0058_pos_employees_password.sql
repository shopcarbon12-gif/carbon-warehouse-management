-- 2026-05-06 — POS-specific password storage on pos_employees.
--
-- Until now POS users authenticated against users.password_hash, which is
-- the same column WMS uses for its own login. That meant changing the POS
-- password also changed the WMS password (and vice-versa) — operators who
-- want to keep their WMS account (e.g. shopcarbon admin email) on a
-- different password from the in-store POS terminal had no way to do it.
--
-- This migration adds pos_employees.pos_password_hash. Once the POS auth
-- code is flipped over to read from this column, the two passwords are
-- fully decoupled. createTenantPosManager initialises both columns to the
-- same hash so legacy POS deployments that still read users.password_hash
-- continue to work; updateTenantPosUser's new resetPassword path writes
-- only to pos_password_hash so a WMS-side reset never touches the WMS
-- login.
--
-- Idempotent — safe to re-run. Wrapped in a regclass check because
-- pos_employees is owned by Carbon-POS (separate app), not WMS; a
-- WMS-only dev/CI DB doesn't have the table and an unconditional
-- ALTER would 42P01. Matches the pattern in 0057_pos_access.sql.
DO $$
BEGIN
  IF to_regclass('public.pos_employees') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE pos_employees ADD COLUMN IF NOT EXISTS pos_password_hash TEXT';
  END IF;
END $$;
