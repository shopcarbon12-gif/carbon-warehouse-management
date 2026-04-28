-- v3.0: Carbon CDM hardware hierarchy.
-- Adds zones, cdm_agents, antenna_profiles. Extends devices with
-- zone_id, parent_device_id, cdm_agent_id so antennas can hang under
-- their parent reader and agents can claim ownership of devices.

CREATE TABLE IF NOT EXISTS zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS zones_tenant_idx ON zones (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS zones_location_idx ON zones (location_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS zones_unique_per_location ON zones (location_id, lower(name));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS cdm_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  hostname varchar(256),
  api_token_hash varchar(128) NOT NULL,
  last_heartbeat_at timestamptz,
  agent_version varchar(32),
  status varchar(16) NOT NULL DEFAULT 'offline',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE cdm_agents ADD CONSTRAINT cdm_agents_status_check
    CHECK (status IN ('online', 'offline', 'degraded'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cdm_agents_tenant_idx ON cdm_agents (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS cdm_agents_location_idx ON cdm_agents (location_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS cdm_agents_unique_per_location ON cdm_agents (location_id, lower(name));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS antenna_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name varchar(64) NOT NULL,
  transmit_power_dbm numeric(4,1) NOT NULL DEFAULT 30.0,
  receive_sensitivity_dbm numeric(4,1),
  mode varchar(32) NOT NULL DEFAULT 'max_throughput',
  session smallint NOT NULL DEFAULT 1,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE antenna_profiles ADD CONSTRAINT antenna_profiles_session_check
    CHECK (session BETWEEN 0 AND 3);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE antenna_profiles ADD CONSTRAINT antenna_profiles_mode_check
    CHECK (mode IN ('max_throughput', 'dense_reader', 'hybrid', 'auto'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS antenna_profiles_tenant_idx ON antenna_profiles (tenant_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS antenna_profiles_unique_per_tenant ON antenna_profiles (tenant_id, lower(name));
--> statement-breakpoint

ALTER TABLE devices ADD COLUMN IF NOT EXISTS zone_id uuid REFERENCES zones (id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS parent_device_id uuid REFERENCES devices (id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS cdm_agent_id uuid REFERENCES cdm_agents (id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS devices_zone_idx ON devices (zone_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS devices_parent_idx ON devices (parent_device_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS devices_cdm_agent_idx ON devices (cdm_agent_id);
