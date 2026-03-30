-- Tenant-scoped JSONB settings for web admin + handheld mobile sync (EPC, profiles, handheld toggles/templates).
CREATE TABLE IF NOT EXISTS tenant_settings (
  id SERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  epc_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  epc_profiles JSONB NOT NULL DEFAULT '[]'::jsonb,
  handheld_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now (),
  CONSTRAINT tenant_settings_tenant_id_unique UNIQUE (tenant_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS tenant_settings_tenant_id_idx ON tenant_settings (tenant_id);
