-- Carbon Shield (Shopify → Carbon Shield, owner 2026-10-20): the storefront
-- bot guard. A script in the live theme asks /api/shield/check about every
-- page view; the verdict comes from the rules below. Store-level (one Shopify
-- store), so these tables carry no tenant.

-- One row. mode: off = the theme script does nothing; monitor = every visit is
-- scored and logged but nobody is blocked; enforce = bots are blocked.
CREATE TABLE IF NOT EXISTS shield_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mode text NOT NULL DEFAULT 'monitor' CHECK (mode IN ('off', 'monitor', 'enforce')),
  allowed_countries text[] NOT NULL DEFAULT ARRAY['US', 'CA']::text[],
  block_countries boolean NOT NULL DEFAULT true,
  block_datacenter boolean NOT NULL DEFAULT true,
  block_automation boolean NOT NULL DEFAULT true,
  block_fast boolean NOT NULL DEFAULT true,
  max_pages_per_minute integer NOT NULL DEFAULT 40 CHECK (max_pages_per_minute BETWEEN 5 AND 1000),
  -- Flagged visitors are told to Shopify as "no tracking" so the ad pixels do
  -- not learn from them (applies in enforce mode only).
  silence_pixels boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_email text
);
INSERT INTO shield_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Manual allow / block rules. Allow always wins over every automatic check.
CREATE TABLE IF NOT EXISTS shield_rules (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ip', 'cidr', 'asn', 'country', 'ua', 'visitor')),
  value text NOT NULL,
  action text NOT NULL CHECK (action IN ('allow', 'block')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by_email text,
  UNIQUE (kind, value)
);

-- One row per checked page view. Kept 7 days (worker), then only the daily
-- totals below remain — so the table can never grow without bound.
CREATE TABLE IF NOT EXISTS shield_events (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  visitor_id text,
  ip inet,
  country text,
  asn integer,
  as_org text,
  -- What happened (allow / block) and what would have happened in enforce
  -- mode — the same unless the store is in monitor mode.
  verdict text NOT NULL,
  would_verdict text NOT NULL,
  reasons text[] NOT NULL DEFAULT '{}'::text[],
  good_bot text,
  mode text NOT NULL,
  path text,
  referrer_host text,
  source text,
  ad_click text,
  ua text
);
CREATE INDEX IF NOT EXISTS shield_events_at_idx ON shield_events (at DESC);
CREATE INDEX IF NOT EXISTS shield_events_ip_at_idx ON shield_events (ip, at DESC);
CREATE INDEX IF NOT EXISTS shield_events_visitor_at_idx ON shield_events (visitor_id, at DESC);

-- Daily totals, kept long after the raw rows are gone.
CREATE TABLE IF NOT EXISTS shield_daily (
  day date NOT NULL,
  would_verdict text NOT NULL,
  reason text NOT NULL,
  source text NOT NULL,
  country text NOT NULL,
  visits integer NOT NULL DEFAULT 0,
  visitors integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, would_verdict, reason, source, country)
);

-- Packed IP → country / network data and the verified-crawler ranges, built
-- by the worker from free published lists (DB-IP Lite, Google, Bing) and read
-- into memory by the check endpoint.
CREATE TABLE IF NOT EXISTS shield_ipdb (
  kind text PRIMARY KEY,
  version text NOT NULL,
  row_count integer NOT NULL,
  data bytea NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now()
);
