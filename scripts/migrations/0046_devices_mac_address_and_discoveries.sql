-- 2026-05-02 — auto-IP-tracking + auto-static for WIZnet-bridged readers.
--
-- devices.mac_address: lets the agent identify a reader by its WIZnet MAC,
-- not its DHCP-shuffled IP. When a reader's IP changes (router lease pool
-- empty, manual reboot, etc.), the agent matches by MAC and auto-updates
-- devices.network_address — operator never has to edit.
--
-- cdm_agent_discoveries: log of WIZnet bridges seen by the agent that
-- aren't yet bound to a device. Admin can adopt one from the hardware-
-- config UI; adoption assigns a static IP via wiznet-cli on the agent
-- side and creates the corresponding devices row.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mac_address TEXT;
CREATE INDEX IF NOT EXISTS devices_mac_address_idx
  ON devices (lower(mac_address))
  WHERE mac_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS cdm_agent_discoveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cdm_agent_id    UUID NOT NULL REFERENCES cdm_agents (id) ON DELETE CASCADE,
  mac_address     TEXT NOT NULL,
  current_ip      TEXT NOT NULL,
  port            INT  NOT NULL DEFAULT 10002,
  dhcp_enabled    BOOLEAN,
  raw             JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  adopted_at      TIMESTAMPTZ,
  adopted_by      UUID REFERENCES users (id) ON DELETE SET NULL,
  ignored_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS cdm_agent_discoveries_unique_mac
  ON cdm_agent_discoveries (cdm_agent_id, lower(mac_address));
