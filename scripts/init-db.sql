-- Carbon Jeans — Orlando Warehouse 001
CREATE TABLE IF NOT EXISTS warehouse_zones (
  code TEXT PRIMARY KEY
);

INSERT INTO warehouse_zones (code) VALUES
  ('1A'), ('1B'), ('1C'),
  ('2A'), ('2B'),
  ('3A'), ('3B'),
  ('4A'), ('4B'),
  ('5A'), ('5B'),
  ('6A'), ('6B')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS skus (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  title TEXT,
  shopify_variant_id TEXT,
  lightspeed_item_id TEXT,
  senitron_tag_hint TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_levels (
  id SERIAL PRIMARY KEY,
  sku_id INT NOT NULL REFERENCES skus(id) ON DELETE CASCADE,
  zone_code TEXT NOT NULL REFERENCES warehouse_zones(code),
  quantity INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sku_id, zone_code)
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  external_ref TEXT,
  source TEXT NOT NULL CHECK (source IN ('shopify', 'lightspeed', 'manual', 'senitron')),
  status TEXT NOT NULL,
  line_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_source ON orders (source);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

CREATE TABLE IF NOT EXISTS sync_runs (
  id SERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('shopify', 'lightspeed', 'senitron')),
  status TEXT NOT NULL,
  message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_provider_started ON sync_runs (provider, started_at DESC);

-- Demo rows (safe on empty DB)
INSERT INTO skus (sku, title, shopify_variant_id)
VALUES ('CJ-DEMO-001', 'Carbon Jeans Demo SKU', 'demo-shopify-1')
ON CONFLICT (sku) DO NOTHING;

INSERT INTO inventory_levels (sku_id, zone_code, quantity)
SELECT s.id, '1A', 120
FROM skus s WHERE s.sku = 'CJ-DEMO-001'
ON CONFLICT (sku_id, zone_code) DO NOTHING;

INSERT INTO orders (external_ref, source, status, line_count)
SELECT '#1001-demo', 'shopify', 'ready_to_pick', 2
WHERE NOT EXISTS (SELECT 1 FROM orders LIMIT 1);

INSERT INTO sync_runs (provider, status, message, finished_at)
SELECT 'shopify', 'ok', 'Seed — configure SHOPIFY_* for live sync', now()
WHERE NOT EXISTS (SELECT 1 FROM sync_runs LIMIT 1);
