-- Carbon WMS: 3-tier Retail Matrix (UPC → Variant → EPC) + bins.
-- Replaces flat products/items from 001. Safe in early build: drops prior RFID tables first.

DROP TABLE IF EXISTS items CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS variants CASCADE;
--> statement-breakpoint
DROP TABLE IF EXISTS products CASCADE;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE CASCADE ON UPDATE CASCADE,
  code varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bins_location_code_unique UNIQUE (location_id, code)
);
--> statement-breakpoint
CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  upc varchar(32) NOT NULL,
  title varchar(512) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT products_upc_unique UNIQUE (upc)
);
--> statement-breakpoint
CREATE TABLE variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  product_id uuid NOT NULL REFERENCES products (id) ON DELETE CASCADE ON UPDATE CASCADE,
  sku varchar(128) NOT NULL,
  ls_system_id bigint NOT NULL,
  color_code varchar(64),
  size varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT variants_sku_unique UNIQUE (sku),
  CONSTRAINT variants_ls_system_id_unique UNIQUE (ls_system_id)
);
--> statement-breakpoint
CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  epc varchar(24) NOT NULL,
  serial_number bigint NOT NULL,
  variant_id uuid NOT NULL REFERENCES variants (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  location_id uuid NOT NULL REFERENCES locations (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  bin_id uuid REFERENCES bins (id) ON DELETE SET NULL ON UPDATE CASCADE,
  status varchar(32) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT items_epc_unique UNIQUE (epc),
  CONSTRAINT items_status_check CHECK (status IN ('in-stock', 'sold', 'in-transit', 'missing'))
);
--> statement-breakpoint
-- UNIQUE (epc) above is the primary B-tree for tag lookups / ON CONFLICT (epc).
CREATE INDEX items_variant_id_status_idx ON items (variant_id, status);
