-- Idempotent bootstrap for production first boot (psql).
-- Login after seed: admin@example.com / ChangeMeOnFirstLogin!1  (change immediately)

INSERT INTO tenants (slug, name)
VALUES ('cj', 'Carbon Jewelry (sample)')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO locations (tenant_id, code, name)
SELECT t.id, v.code, v.name
FROM tenants t
CROSS JOIN (VALUES
  ('001', 'Orlando Warehouse'),
  ('003', 'Elementi Florida Mall')
) AS v(code, name)
WHERE t.slug = 'cj'
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO users (email, password_hash)
VALUES (
  'admin@example.com',
  '$2b$10$HNrXT8Jd2qXcTIAJ9CepruBQLdf5CLdMY8zMnypX9R3FIFN3eVqW.'
)
ON CONFLICT (email) DO NOTHING;

INSERT INTO memberships (user_id, tenant_id, role)
SELECT u.id, t.id, 'admin'
FROM users u
CROSS JOIN tenants t
WHERE u.email = 'admin@example.com' AND t.slug = 'cj'
ON CONFLICT (user_id, tenant_id) DO NOTHING;

INSERT INTO orders (tenant_id, location_id, external_ref, source, status, line_count)
SELECT t.id, l.id, 'LS-10021', 'lightspeed', 'picking', 4
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
  AND NOT EXISTS (SELECT 1 FROM orders LIMIT 1);

INSERT INTO orders (tenant_id, location_id, external_ref, source, status, line_count)
SELECT t.id, l.id, 'SH-55402', 'shopify', 'pending', 2
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
  AND EXISTS (SELECT 1 FROM orders WHERE external_ref = 'LS-10021' LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM orders WHERE external_ref = 'SH-55402' LIMIT 1);

INSERT INTO inventory_items (location_id, asset_id, sku, name, zone, qty)
SELECT l.id, '210000001206', 'C125311010701', 'AVA MINI DRESS BLACK S', 'rfid', 2
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
  AND NOT EXISTS (SELECT 1 FROM inventory_items LIMIT 1);

INSERT INTO inventory_items (location_id, asset_id, sku, name, zone, qty)
SELECT l.id, '210000007117', '—', 'ISLA KNIT BLACK OS', 'bin', 24
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
  AND EXISTS (SELECT 1 FROM inventory_items WHERE asset_id = '210000001206' LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM inventory_items WHERE asset_id = '210000007117' LIMIT 1);

INSERT INTO integration_connections (tenant_id, location_id, provider, status, last_ok_at)
SELECT t.id, NULL, 'senitron', 'connected', now()
FROM tenants t
WHERE t.slug = 'cj'
  AND NOT EXISTS (
    SELECT 1 FROM integration_connections ic
    WHERE ic.tenant_id = t.id AND ic.provider = 'senitron'
  );

INSERT INTO integration_connections (tenant_id, location_id, provider, status, last_ok_at)
SELECT t.id, l.id, 'lightspeed', 'connected', now()
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
  AND NOT EXISTS (
    SELECT 1 FROM integration_connections ic
    WHERE ic.tenant_id = t.id AND ic.provider = 'lightspeed'
  );

INSERT INTO integration_connections (tenant_id, location_id, provider, status, last_ok_at)
SELECT t.id, l.id, 'shopify', 'configure', NULL
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
  AND NOT EXISTS (
    SELECT 1 FROM integration_connections ic
    WHERE ic.tenant_id = t.id AND ic.provider = 'shopify'
  );

INSERT INTO exceptions (tenant_id, location_id, type, severity, state, detail)
SELECT t.id, l.id, 'pos_mismatch', 'review', 'new', '210000007117 · RFID 24 vs Ext 0'
FROM tenants t
JOIN locations l ON l.tenant_id = t.id AND l.code = '001'
WHERE t.slug = 'cj'
  AND NOT EXISTS (SELECT 1 FROM exceptions LIMIT 1);
