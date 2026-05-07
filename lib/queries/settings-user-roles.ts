import type { Pool } from "pg";

export type RoleScope = "wms" | "pos";

export type UserRoleRow = {
  id: number;
  name: string;
  scope: RoleScope;
  permissions: unknown;
  created_at: string;
  updated_at: string;
};

/**
 * List roles, optionally filtered by scope. WMS user-roles UI passes 'wms';
 * POS roles UI passes 'pos'. Omit to get all.
 */
export async function listUserRoles(
  pool: Pool,
  scope?: RoleScope,
): Promise<UserRoleRow[]> {
  const sql = scope
    ? `SELECT id, name, scope, permissions, created_at, updated_at
       FROM user_roles
       WHERE scope = $1
       ORDER BY id ASC`
    : `SELECT id, name, scope, permissions, created_at, updated_at
       FROM user_roles
       ORDER BY id ASC`;
  const params = scope ? [scope] : [];
  const r = await pool.query<{
    id: number;
    name: string;
    scope: RoleScope;
    permissions: unknown;
    created_at: Date;
    updated_at: Date;
  }>(sql, params);
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    scope: row.scope,
    permissions: row.permissions,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

export async function insertUserRole(
  pool: Pool,
  name: string,
  permissions: unknown,
  scope: RoleScope = "wms",
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO user_roles (name, permissions, scope)
     VALUES ($1, $2::jsonb, $3)
     RETURNING id`,
    [name.trim(), JSON.stringify(permissions ?? {}), scope],
  );
  const id = r.rows[0]?.id;
  if (id == null) throw new Error("insertUserRole failed");
  return id;
}

export async function updateUserRole(
  pool: Pool,
  id: number,
  input: { name: string; permissions: unknown },
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE user_roles
        SET name = $2, permissions = $3::jsonb, updated_at = now()
      WHERE id = $1::int`,
    [id, input.name.trim(), JSON.stringify(input.permissions ?? {})],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function deleteUserRole(
  pool: Pool,
  id: number,
): Promise<"deleted" | "in_use" | "not_found"> {
  // A role is in use if any WMS user (users.role_id) or POS employee
  // (pos_employees.pos_role_id, when present) references it.
  const u = await pool.query(`SELECT 1 FROM users WHERE role_id = $1::int LIMIT 1`, [id]);
  if (u.rows[0]) return "in_use";
  const peExists = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pos_employees' AND column_name = 'pos_role_id'
     ) AS exists`,
  );
  if (peExists.rows[0]?.exists) {
    const p = await pool.query(
      `SELECT 1 FROM pos_employees WHERE pos_role_id = $1::int LIMIT 1`,
      [id],
    );
    if (p.rows[0]) return "in_use";
  }
  const r = await pool.query(`DELETE FROM user_roles WHERE id = $1::int`, [id]);
  return (r.rowCount ?? 0) > 0 ? "deleted" : "not_found";
}
