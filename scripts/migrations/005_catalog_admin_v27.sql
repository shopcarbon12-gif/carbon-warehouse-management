-- v2.7: matrix catalog dimensions, bin capacity/archive, tenant settings JSON.

ALTER TABLE matrices ADD COLUMN IF NOT EXISTS brand varchar(128);
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS category varchar(128);
ALTER TABLE matrices ADD COLUMN IF NOT EXISTS vendor varchar(128);
--> statement-breakpoint
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS asset_id varchar(64);
ALTER TABLE custom_skus ADD COLUMN IF NOT EXISTS retail_price numeric(12, 2);
--> statement-breakpoint
ALTER TABLE bins ADD COLUMN IF NOT EXISTS capacity integer;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS settings jsonb DEFAULT '{}'::jsonb;
