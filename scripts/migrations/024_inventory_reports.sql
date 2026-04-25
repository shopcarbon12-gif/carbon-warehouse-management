-- Audit archive for handheld count sessions (1-year retention).
-- Distinct from `device_upload_logs` (014): that one is an automatic raw-CSV
-- side-effect logger of every /api/inventory/upload call. This one is an
-- intent-driven archive populated by an explicit POST from the mobile
-- Continue screen, with structured fields and an enforced expiry.
CREATE TABLE IF NOT EXISTS inventory_reports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  activity         TEXT NOT NULL,
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  uploaded_by      TEXT,
  device_id        TEXT,
  override_catalog BOOLEAN NOT NULL DEFAULT FALSE,
  row_count        INT NOT NULL,
  csv_content      TEXT NOT NULL,
  filename         TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_reports_tenant_uploaded_idx
  ON inventory_reports (tenant_id, uploaded_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_reports_activity_idx
  ON inventory_reports (activity);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_reports_expires_at_idx
  ON inventory_reports (expires_at);
