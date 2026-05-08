-- 2026-05-08 — bridge-reachability tracking for tri-state Hardware Config dot.
--
-- The agent already runs `wiznet-cli -d` every minute and reports every MAC
-- it sees on the LAN. For BOUND bridges (MAC in devices.mac_address), the
-- discovery handler updates network_address on IP shuffles but otherwise
-- skips the cdm_agent_discoveries upsert (those rows are for orphan bridges
-- only, surfaced to the admin's "Discovered" panel).
--
-- That means we have no per-device "I saw your bridge on the LAN N seconds
-- ago" timestamp for bound readers — needed for distinguishing:
--   GREEN  — chip producing valid new_monsoonreader output (status_online=true)
--   YELLOW — bridge reachable on LAN, but chip not producing valid output
--            (chassis on the network but firmware not delivering reads)
--   RED    — bridge missed last few discovery sweeps (cable / chassis power)
--
-- bridge_seen_at is bumped by lib/server/wiznet-discoveries.ts on every MAC
-- match in the agent's sweep; lib/server/hardware-config.ts derives the
-- yellow state by checking now() - bridge_seen_at < ~3 minutes.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS bridge_seen_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS devices_bridge_seen_at_idx
  ON devices (bridge_seen_at)
  WHERE bridge_seen_at IS NOT NULL;
