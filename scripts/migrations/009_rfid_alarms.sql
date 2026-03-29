-- Exception / alarm events from handheld edge (e.g. EXCEPTION_ALARM scan context).
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rfid_alarms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  device_id varchar(256) NOT NULL,
  scan_context varchar(64) NOT NULL DEFAULT 'EXCEPTION_ALARM',
  epcs jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rfid_alarms_tenant_created_idx
  ON rfid_alarms (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rfid_alarms_location_created_idx
  ON rfid_alarms (location_id, created_at DESC);
