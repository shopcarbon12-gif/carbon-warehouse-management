-- 2026-05-06 — POS access groundwork.
--
-- 1. Per-location credentials. Each WMS location can be sold-against from the
--    POS, and each one gets its own contact email + bcrypt-hashed password
--    (used by Carbon-POS to authenticate location-scoped flows).
-- 2. user_roles get a `scope` discriminator so the same name (e.g. "Super
--    Admin") can exist independently for WMS and POS. Default is 'wms' so
--    every existing row keeps its current behavior.
-- 3. Seed two POS roles, "Super Admin" and "Manager", with empty permissions
--    JSONB. Empty defaults to all-visible in the UI (omitted keys → "view"),
--    so both roles ship with full POS access until an admin narrows them.

ALTER TABLE locations
  ADD COLUMN IF NOT EXISTS email         TEXT,
  ADD COLUMN IF NOT EXISTS password_hash TEXT;

ALTER TABLE user_roles
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'wms';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_roles_scope_chk'
  ) THEN
    ALTER TABLE user_roles
      ADD CONSTRAINT user_roles_scope_chk CHECK (scope IN ('wms','pos'));
  END IF;
END $$;

-- Old uniqueness was on (name) alone. Replace with (name, scope) so a POS
-- "Super Admin" can coexist with a WMS "Super Admin".
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_roles_name_key' AND conrelid = 'user_roles'::regclass
  ) THEN
    ALTER TABLE user_roles DROP CONSTRAINT user_roles_name_key;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS user_roles_name_scope_uidx
  ON user_roles (name, scope);

INSERT INTO user_roles (name, permissions, scope)
VALUES
  ('Super Admin', '{}'::jsonb, 'pos'),
  ('Manager',     '{}'::jsonb, 'pos')
ON CONFLICT (name, scope) DO UPDATE SET
  updated_at = now();

-- pos_employees lives in the same Postgres but is owned by Carbon-POS's
-- migrations. If it exists here, give it a FK back to user_roles so we can
-- assign POS roles from the WMS UI. If the POS schema hasn't been applied
-- yet (fresh local dev), this is a no-op — the column gets added the first
-- time `pos_employees` is created (Carbon-POS migration 001).
DO $$
BEGIN
  IF to_regclass('public.pos_employees') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_name = 'pos_employees' AND column_name = 'pos_role_id'
     )
  THEN
    EXECUTE 'ALTER TABLE pos_employees ADD COLUMN pos_role_id INTEGER REFERENCES user_roles(id) ON DELETE SET NULL';
  END IF;
END $$;
