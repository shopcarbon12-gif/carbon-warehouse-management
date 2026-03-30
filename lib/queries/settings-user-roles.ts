import type { Pool } from "pg";

export type UserRoleRow = {
  id: number;
  name: string;
  permissions: unknown;
  created_at: string;
  updated_at: string;
};

export async function listUserRoles(pool: Pool): Promise<UserRoleRow[]> {
  const r = await pool.query<{
    id: number;
    name: string;
    permissions: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, name, permissions, created_at, updated_at
     FROM user_roles
     ORDER BY id ASC`,
  );
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    permissions: row.permissions,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}

export async function insertUserRole(
  pool: Pool,
  name: string,
  permissions: unknown,
): Promise<number> {
  const r = await pool.query<{ id: number }>(
    `INSERT INTO user_roles (name, permissions) VALUES ($1, $2::jsonb)
     RETURNING id`,
    [name.trim(), JSON.stringify(permissions ?? {})],
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
  const u = await pool.query(`SELECT 1 FROM users WHERE role_id = $1::int LIMIT 1`, [id]);
  if (u.rows[0]) return "in_use";
  const r = await pool.query(`DELETE FROM user_roles WHERE id = $1::int`, [id]);
  return (r.rowCount ?? 0) > 0 ? "deleted" : "not_found";
}
