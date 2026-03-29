-- v2.8: Lightspeed catalog sync credentials table + matrix / SKU columns for ingestion.

CREATE TABLE IF NOT EXISTS infrastructure_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  ls_client_id varchar(512),
  ls_client_secret varchar(512),
  ls_account_id varchar(128),
  ls_domain_prefix varchar(128),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS ls_system_id bigint;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS matrices_ls_system_id_uidx
  ON matrices (ls_system_id)
  WHERE ls_system_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS upc varchar(32);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS custom_skus_upc_idx ON custom_skus (upc)
  WHERE upc IS NOT NULL AND trim(upc) <> '';
