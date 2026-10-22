import bcrypt from "bcryptjs";
import type { Pool } from "pg";
import type { SessionPayload } from "@/lib/auth";
import { sessionRoleFromUserRoleName } from "@/lib/auth/user-role-map";

// A fixed bcrypt hash of a random string. When the email is unknown we still
// run a compare against this so an unknown email takes the same time as a
// known one, closing the account-enumeration-by-timing side channel.
const DUMMY_PASSWORD_HASH =
  "$2a$10$CwTycUXWue0Thq9StjUM0uJ8DQ6a9Qy6pP9lP0qf4sP3wZt6m7uQK";

function parseDeviceBypass(permissions: unknown): boolean {
  if (!permissions || typeof permissions !== "object") return false;
  const ds = (permissions as Record<string, unknown>).device_security;
  if (!ds || typeof ds !== "object") return false;
  return Boolean((ds as Record<string, unknown>).can_bypass_device_lock);
}

export async function findUserWithTenantLocation(
  pool: Pool,
  email: string,
  password: string,
): Promise<SessionPayload | null> {
  const u = await pool.query<{ id: string; password_hash: string }>(
    `SELECT id, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  const user = u.rows[0];
  if (!user) {
    // Spend the same time as a real compare so timing doesn't reveal which
    // emails exist. Result is ignored.
    try {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
    } catch {
      /* ignore */
    }
    return null;
  }
  let ok = false;
  try {
    ok = await bcrypt.compare(password, user.password_hash);
  } catch {
    return null;
  }
  if (!ok) return null;

  const loc = await pool.query<{
    tid: string;
    lid: string;
    role: string;
    role_name: string | null;
    permissions: unknown;
  }>(
    `SELECT
       m.tenant_id AS tid,
       l.id AS lid,
       m.role,
       ur.name AS role_name,
       ur.permissions AS permissions
     FROM memberships m
     JOIN users u0 ON u0.id = m.user_id
     JOIN locations l ON l.tenant_id = m.tenant_id AND l.is_active = true
     LEFT JOIN user_roles ur ON ur.id = u0.role_id
     WHERE m.user_id = $1::uuid
       AND (
         NOT EXISTS (
           SELECT 1
           FROM user_locations ul
           JOIN locations lx ON lx.id = ul.location_id
           WHERE ul.user_id = m.user_id
             AND lx.tenant_id = m.tenant_id
         )
         OR EXISTS (
           SELECT 1
           FROM user_locations ul
           WHERE ul.user_id = m.user_id
             AND ul.location_id = l.id
         )
       )
     ORDER BY l.code ASC
     LIMIT 1`,
    [user.id],
  );
  const row = loc.rows[0];
  if (!row) return null;

  const mapped = sessionRoleFromUserRoleName(row.role_name);
  const role = mapped ?? (row.role?.trim() || "member");
  const bypassDeviceLock = parseDeviceBypass(row.permissions);

  return {
    sub: user.id,
    email,
    tid: row.tid,
    lid: row.lid,
    role,
    ...(bypassDeviceLock ? { bypassDeviceLock: true } : {}),
  };
}

export async function assertLocationForTenant(
  pool: Pool,
  tenantId: string,
  locationId: string,
  userId?: string,
): Promise<boolean> {
  const params: unknown[] = [locationId, tenantId];
  let assignmentSql = "true";
  if (userId) {
    assignmentSql = `(
      NOT EXISTS (
        SELECT 1
        FROM user_locations ul
        JOIN locations lx ON lx.id = ul.location_id
        WHERE ul.user_id = $3::uuid
          AND lx.tenant_id = $2::uuid
      )
      OR EXISTS (
        SELECT 1
        FROM user_locations ul
        WHERE ul.user_id = $3::uuid
          AND ul.location_id = $1::uuid
      )
    )`;
    params.push(userId);
  }

  const r = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok
     FROM locations l
     WHERE l.id = $1::uuid
       AND l.tenant_id = $2::uuid
       AND l.is_active = true
       AND ${assignmentSql}
     LIMIT 1`,
    params,
  );
  return r.rows[0] != null;
}
