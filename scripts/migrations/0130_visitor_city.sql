-- Visitors: city and state/province from the visitor's IP (owner 2026-10-21:
-- "it's just telling me the country"). City-level is the most an IP gives —
-- never a street. Looked up once per IP through DB-IP's free city API
-- (CC BY 4.0, the same provider as the Shield's country list) and cached.
ALTER TABLE visitors
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS region text,
  ADD COLUMN IF NOT EXISTS region_code text;

CREATE TABLE IF NOT EXISTS ip_geo_cache (
  ip          text PRIMARY KEY,
  country     text,
  region      text,
  region_code text,
  city        text,
  at          timestamptz NOT NULL DEFAULT now()
);
