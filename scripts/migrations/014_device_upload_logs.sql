-- Manual CSV uploads from handhelds / audits (raw payload retained for compliance).
CREATE TABLE IF NOT EXISTS device_upload_logs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  device_id VARCHAR(256) NOT NULL,
  workflow_mode VARCHAR(128) NOT NULL,
  raw_csv TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now ()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_upload_logs_tenant_created_idx ON device_upload_logs (tenant_id, created_at DESC);
