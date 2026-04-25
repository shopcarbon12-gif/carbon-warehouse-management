-- Per-device EPC drop queue used by the catalog "Send to handheld" drawer.
-- Web posts a list of EPCs targeted at a single handheld; that handheld's
-- mobile app polls the queue from the new "Cloud + Geiger" screen.
-- Rows are consumed (status = 'consumed') by the mobile poller, not deleted,
-- so the same target device can dedupe and audit can replay history.
CREATE TABLE IF NOT EXISTS device_epc_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  device_id    UUID NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  epc          VARCHAR(64) NOT NULL,
  status       VARCHAR(16) NOT NULL DEFAULT 'pending',
  enqueued_by  UUID,
  enqueued_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at  TIMESTAMPTZ,
  CONSTRAINT device_epc_queue_status_check CHECK (status IN ('pending', 'consumed'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_epc_queue_device_pending_idx
  ON device_epc_queue (device_id, status, enqueued_at DESC) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS device_epc_queue_tenant_enqueued_idx
  ON device_epc_queue (tenant_id, enqueued_at DESC);
--> statement-breakpoint
-- Audit log enrichment: capture WMS user (UUID) and the originating device.
-- Existing `user_id INTEGER` column predates UUID auth and is left in place
-- for backward compat; new writes go to `user_uuid` + `device_id`.
ALTER TABLE inventory_audit_logs
  ADD COLUMN IF NOT EXISTS user_uuid UUID;
--> statement-breakpoint
ALTER TABLE inventory_audit_logs
  ADD COLUMN IF NOT EXISTS device_id VARCHAR(256);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_audit_logs_user_uuid_idx
  ON inventory_audit_logs (user_uuid) WHERE user_uuid IS NOT NULL;
