-- 042_pos_employees_delete_permission.sql
-- Add the "delete" action under the POS "pos_employees" permission group and
-- align existing POS roles with the rule "only Super Admin can permanently
-- delete employees".
--
-- The permission catalog itself is code (lib/settings/pos-permission-catalog.ts);
-- this migration just sets sensible stored values so the POS-roles editor and
-- any consumers reflect the intended default:
--   • Super Admin → delete = view (allowed)
--   • every other scope='pos' role → delete = hide
--
-- Uses jsonb merge (||) so it works whether or not the role already has a
-- pos_employees permission object. Idempotent.

BEGIN;

-- Super Admin: grant delete.
UPDATE user_roles
   SET permissions = COALESCE(permissions, '{}'::jsonb)
        || jsonb_build_object(
             'pos_employees',
             COALESCE(permissions -> 'pos_employees', '{}'::jsonb)
               || jsonb_build_object('delete', 'view')
           ),
       updated_at = now()
 WHERE scope = 'pos' AND name = 'Super Admin';

-- Everyone else: explicitly hide delete.
UPDATE user_roles
   SET permissions = COALESCE(permissions, '{}'::jsonb)
        || jsonb_build_object(
             'pos_employees',
             COALESCE(permissions -> 'pos_employees', '{}'::jsonb)
               || jsonb_build_object('delete', 'hide')
           ),
       updated_at = now()
 WHERE scope = 'pos' AND name <> 'Super Admin';

COMMIT;
