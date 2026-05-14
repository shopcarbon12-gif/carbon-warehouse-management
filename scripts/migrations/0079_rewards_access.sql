-- Rewards (loyalty) credentials access — third scope alongside 'wms' and 'pos'.
--
-- Mirrors the POS access pattern from migration 0057:
--   - user_roles.scope grows from {'wms','pos'} to {'wms','pos','rewards'}.
--   - Same name+scope unique index lets each scope have its own "Super Admin"
--     and "Manager" rows independent of the other scopes.
--   - rewards_employees table holds the per-user state for the rewards app
--     (loyalty.shopcarbon.com). Login is by users.email + rewards_password_hash;
--     authorization comes from rewards_role_id (a user_roles row with
--     scope='rewards'). Active=FALSE soft-disables the credential.
--
-- Carbon-Loyalty (loyalty.shopcarbon.com) authenticates against this table —
-- shared Postgres, same pattern Carbon-POS uses against pos_employees.

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_chk;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_scope_chk CHECK (scope IN ('wms','pos','rewards'));

INSERT INTO user_roles (name, permissions, scope)
VALUES
  ('Super Admin', '{}'::jsonb, 'rewards'),
  ('Manager',     '{}'::jsonb, 'rewards')
ON CONFLICT (name, scope) DO UPDATE SET
  updated_at = now();

CREATE TABLE IF NOT EXISTS rewards_employees (
  id              SERIAL PRIMARY KEY,
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  rewards_role_id INTEGER REFERENCES user_roles(id) ON DELETE SET NULL,
  /* Separate password from the WMS/POS hashes so revoking rewards access
     doesn't lock the user out of WMS or POS. NULL = credential not set yet. */
  rewards_password_hash TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rewards_employees_role_idx
  ON rewards_employees (rewards_role_id);
