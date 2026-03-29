-- Carbon WMS: RFID core — extend locations, add products + items.
-- Idempotent (safe to re-run). Applied after scripts/schema.sql via npm run db:migrate.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN IF NOT EXISTS type varchar(32);
--> statement-breakpoint
UPDATE locations SET type = 'warehouse' WHERE type IS NULL;
--> statement-breakpoint
ALTER TABLE locations ALTER COLUMN type SET DEFAULT 'warehouse';
--> statement-breakpoint
ALTER TABLE locations ALTER COLUMN type SET NOT NULL;
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN IF NOT EXISTS shopify_location_id varchar(128);
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN IF NOT EXISTS lightspeed_location_id varchar(128);
--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE locations
    ADD CONSTRAINT locations_type_check
    CHECK (type IN ('warehouse', 'retail'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  sku varchar(128) NOT NULL,
  title varchar(512) NOT NULL,
  barcode varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_sku_unique UNIQUE (sku)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  epc varchar(256) NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  status varchar(32) NOT NULL,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_epc_unique UNIQUE (epc),
  CONSTRAINT items_status_check CHECK (status IN ('in-stock', 'sold', 'in-transit', 'missing'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_location_id_idx ON items (location_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_status_idx ON items (status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS items_location_status_idx ON items (location_id, status);
