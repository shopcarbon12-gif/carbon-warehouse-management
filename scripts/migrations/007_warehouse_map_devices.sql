-- v2.9: Bin operational status + tenant devices registry (printers / RFID edge).

ALTER TABLE bins DROP CONSTRAINT IF EXISTS bins_status_check;
--> statement-breakpoint
ALTER TABLE bins ADD COLUMN IF NOT EXISTS status varchar(16) NOT NULL DEFAULT 'active';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE bins ADD CONSTRAINT bins_status_check CHECK (status IN ('active', 'inactive'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  bin_id uuid REFERENCES bins (id) ON DELETE SET NULL,
  device_type varchar(32) NOT NULL,
  name varchar(256) NOT NULL,
  network_address varchar(256),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status_online boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT devices_device_type_check CHECK (
    device_type IN (
      'printer',
      'handheld_reader',
      'fixed_reader',
      'transaction_reader',
      'door_reader',
      'antenna'
    )
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS devices_tenant_idx ON devices (tenant_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS devices_location_idx ON devices (location_id);
