-- User-defined roles (JSONB permissions) + user.role_id + location shop IDs + user↔location assignments.
CREATE TABLE IF NOT EXISTS user_roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(256) NOT NULL UNIQUE,
  permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE users ADD COLUMN IF NOT EXISTS role_id INTEGER REFERENCES user_roles (id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN IF NOT EXISTS lightspeed_shop_id INTEGER;
--> statement-breakpoint
ALTER TABLE locations ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS locations_tenant_lightspeed_shop_uidx
  ON locations (tenant_id, lightspeed_shop_id)
  WHERE lightspeed_shop_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_locations (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_locations_location_id_idx ON user_locations (location_id);
--> statement-breakpoint
INSERT INTO user_roles (name, permissions)
VALUES
  ('Super Admin', '{}'::jsonb),
  ('Retail- Limited acess', '{}'::jsonb),
  ('Warehouse - Limited Access', '{}'::jsonb)
ON CONFLICT (name) DO UPDATE SET
  updated_at = now();
--> statement-breakpoint
UPDATE users u
SET role_id = sub.rid
FROM (
  SELECT ur.id AS rid
  FROM user_roles ur
  WHERE ur.name = 'Super Admin'
  LIMIT 1
) sub
WHERE u.role_id IS NULL
  AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.user_id = u.id AND lower(trim(m.role)) = 'admin'
  );
--> statement-breakpoint
INSERT INTO user_locations (user_id, location_id)
SELECT m.user_id, l.id
FROM memberships m
JOIN locations l ON l.tenant_id = m.tenant_id
ON CONFLICT DO NOTHING;
