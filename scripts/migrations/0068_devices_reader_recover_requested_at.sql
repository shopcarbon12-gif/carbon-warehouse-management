-- Per-reader hard-reset signal. Analog of cdm_agents.recover_requested_at,
-- but scoped to a single reader. Hardware Config's per-reader Hard Reset
-- button stamps this; the CDM agent supervisor compares it to the slot's
-- spawnedAt on each config-pull and, if newer, force-recreates the slot
-- (stopSlot + freeSlotIndex + drop from map → next reconcile re-spawns
-- with a fresh sweep budget).

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS reader_recover_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reader_recover_requested_by UUID;

CREATE INDEX IF NOT EXISTS devices_reader_recover_requested_at_idx
  ON devices (reader_recover_requested_at)
  WHERE reader_recover_requested_at IS NOT NULL;
