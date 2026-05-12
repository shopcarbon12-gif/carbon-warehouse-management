-- 2026-05-12 — Add suggested_power_dbm + suggested_power_dbm_at to devices.
--
-- Stamped on antenna rows by the cdm-agent's heartbeat when the supervisor's
-- auto-sweep diagnostic finds a working transmit power BELOW the
-- operator-configured value. Live evidence 2026-05-12 against .15:
-- configured 33 dBm produced zero reads, sweep found 15 dBm working.
-- Operator-approval gated: the supervisor never silently downgrades a
-- configured power; instead Hardware Config surfaces a one-click "Apply
-- X dBm" banner.
--
-- Cleared (set to NULL) by the heartbeat the moment a reader self-heals
-- at its configured power (chip was transiently wedged, no downgrade
-- needed). So the banner is self-disposing.

DO $$
BEGIN
  IF to_regclass('public.devices') IS NULL THEN
    RETURN;
  END IF;
  ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS suggested_power_dbm INTEGER,
    ADD COLUMN IF NOT EXISTS suggested_power_dbm_at TIMESTAMPTZ;
END $$;
