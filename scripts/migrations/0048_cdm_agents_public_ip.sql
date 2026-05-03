-- 2026-05-03 — same-public-IP login auto-start.
-- Heartbeat populates this with the agent's public-facing IP (read from
-- the request's x-forwarded-for / x-real-ip header). Dashboard's
-- auto-eligible check compares the operator's login IP against this — if
-- they match, the agent and operator are behind the same NAT (i.e.
-- physically at the warehouse), so we auto-start a live-scan session.
-- Off-network logins (different public IP) require an explicit click.
ALTER TABLE cdm_agents ADD COLUMN IF NOT EXISTS last_known_public_ip TEXT;
ALTER TABLE cdm_agents ADD COLUMN IF NOT EXISTS last_known_public_ip_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS cdm_agents_public_ip_idx
  ON cdm_agents (last_known_public_ip)
  WHERE last_known_public_ip IS NOT NULL;
