-- 0081_pos_register_live_power.sql
--
-- Cashier-driven live RF power override on the POS-dedicated reader.
-- Carbon-POS sell screen exposes a slider (no save button); each drag
-- updates this column for the cashier's currently-open register session.
-- Agent reads this via /api/cdm-agents/active-sessions and applies it as
-- the supervisor's spawn power for the is_pos_dedicated reader bound to
-- the register's agent.
--
-- NULL = use WMS-configured power (steady-state default, typically 33 dBm).
-- Set = override (1–33 dBm).
--
-- The column lives on pos_register_sessions because the override is
-- scoped to a register-open lifecycle: the moment the cashier closes
-- their session, the override no longer applies (next session starts
-- fresh from WMS default).

ALTER TABLE pos_register_sessions
  ADD COLUMN IF NOT EXISTS live_power_dbm SMALLINT;

ALTER TABLE pos_register_sessions
  DROP CONSTRAINT IF EXISTS pos_register_sessions_live_power_dbm_range;

ALTER TABLE pos_register_sessions
  ADD CONSTRAINT pos_register_sessions_live_power_dbm_range
  CHECK (live_power_dbm IS NULL OR (live_power_dbm BETWEEN 1 AND 33));
