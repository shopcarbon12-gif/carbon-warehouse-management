-- Unified inventory reporting / audit tables (tenant-scoped).
CREATE TABLE IF NOT EXISTS inventory_audit_logs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  log_type VARCHAR(64) NOT NULL,
  entity_type VARCHAR(32) NOT NULL,
  entity_reference VARCHAR(512) NOT NULL,
  old_value VARCHAR(512),
  new_value VARCHAR(512),
  reason TEXT,
  user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_audit_logs_log_type_check CHECK (
    log_type IN (
      'STATUS_CHANGE',
      'ADJUSTMENT',
      'KILLED_TAG',
      'RESOLVED_KILLED_TAG',
      'BULK_IMPORT'
    )
  ),
  CONSTRAINT inventory_audit_logs_entity_type_check CHECK (entity_type IN ('EPC', 'SKU'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_audit_logs_tenant_created_idx ON inventory_audit_logs (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS inventory_audit_logs_tenant_type_idx ON inventory_audit_logs (tenant_id, log_type);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS asset_movements (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  epc VARCHAR(256) NOT NULL,
  from_location VARCHAR(256),
  to_location VARCHAR(256) NOT NULL,
  user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_movements_tenant_created_idx ON asset_movements (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS asset_movements_tenant_epc_idx ON asset_movements (tenant_id, epc);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS replenishment_logs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  sku VARCHAR(256) NOT NULL,
  qty INTEGER NOT NULL,
  from_bin VARCHAR(256) NOT NULL,
  to_bin VARCHAR(256) NOT NULL,
  status VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS replenishment_logs_tenant_created_idx ON replenishment_logs (tenant_id, created_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS external_system_logs (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  system_name VARCHAR(128) NOT NULL,
  direction VARCHAR(16) NOT NULL,
  payload_summary TEXT,
  status VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT external_system_logs_direction_check CHECK (direction IN ('INBOUND', 'OUTBOUND'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS external_system_logs_tenant_created_idx ON external_system_logs (tenant_id, created_at DESC);
