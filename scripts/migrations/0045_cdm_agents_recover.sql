-- 2026-05-02 — operator-driven "Recover readers" button on hardware-config.
-- recover_requested_at: stamped by the API when an admin clicks recover.
-- The agent on its next heartbeat compares this against its own boot time;
-- if the request is newer, the agent exits cleanly and systemd respawns it.
-- This kills any stuck child binaries (alive-but-silent) and resets every
-- supervisor slot (consecutiveZeroByteKicks, lastByteAt, etc.) without an
-- SSH round-trip.
ALTER TABLE cdm_agents ADD COLUMN IF NOT EXISTS recover_requested_at TIMESTAMPTZ;
ALTER TABLE cdm_agents ADD COLUMN IF NOT EXISTS recover_requested_by UUID REFERENCES users (id) ON DELETE SET NULL;
