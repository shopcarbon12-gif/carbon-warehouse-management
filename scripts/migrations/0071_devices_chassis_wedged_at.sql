-- 2026-05-12 — Add chassis_wedged_at to devices for the supervisor's
-- per-reader wedge-level state machine.
--
-- Stamped by the agent's heartbeat when its MonsoonSupervisor flags a
-- reader as Level 3 wedged (6+ failed slow-recoveries in 10 min). The
-- supervisor then stops its recovery loop on that slot — the WMS UI's
-- Hardware Config surfaces a "needs hardware service" badge instead of
-- the supervisor silently looping forever.
--
-- Cleared (set to NULL) when the supervisor detects the slot self-healed
-- (>= 50% of peer median reads), so the badge disappears on recovery
-- without operator action.

DO $$
BEGIN
  IF to_regclass('public.devices') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS chassis_wedged_at TIMESTAMPTZ;
END $$;
