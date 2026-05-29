-- WMS Mobile (handheld app) access — fourth role scope alongside wms/pos/rewards.
--
-- Mirrors the POS (0057) and Rewards (0079) access pattern:
--   - user_roles.scope grows to include 'mobile'.
--   - Each scope gets its own "Super Admin" / "Manager" rows via the
--     (name, scope) unique index. Super Admin with empty permissions '{}'
--     means FULL access (same convention POS/Rewards use) — i.e. the WMS
--     Super Admin is full-access across every platform.
--
-- Mobile users ARE the WMS users (the handheld signs in with the same
-- accounts), so there is no separate user table. A user's mobile role is an
-- optional link on the users row. NULL = no explicit mobile role (treated as
-- full access until a role is assigned, matching the empty-perms convention).
--
-- Role permissions enumerate the handheld app's SCREENS — see
-- lib/settings/mobile-permission-catalog.ts. The Flutter app reads the
-- signed-in user's effective permissions and hides/locks screens (Phase 2).

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_scope_chk;
ALTER TABLE user_roles
  ADD CONSTRAINT user_roles_scope_chk CHECK (scope IN ('wms','pos','rewards','mobile'));

INSERT INTO user_roles (name, permissions, scope)
VALUES
  ('Super Admin', '{}'::jsonb, 'mobile'),
  ('Manager',     '{}'::jsonb, 'mobile')
ON CONFLICT (name, scope) DO UPDATE SET
  updated_at = now();

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS mobile_role_id INTEGER REFERENCES user_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS users_mobile_role_idx ON users (mobile_role_id);
