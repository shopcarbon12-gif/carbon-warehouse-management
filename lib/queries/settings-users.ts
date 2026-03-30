import bcrypt from "bcryptjs";
import type { Pool } from "pg";
import { sessionRoleFromUserRoleName } from "@/lib/auth/user-role-map";

export type TenantUserListRow = {
  id: string;
  email: string;
  role_id: number | null;
  role_name: string | null;
  locations: { id: string; code: string; name: string }[];
};

export async function listTenantUsers(
  pool: Pool,
  tenantId: string,
): Promise<TenantUserListRow[]> {
  const r = await pool.query<{
    id: string;
    email: string;
    role_id: string | null;
    role_name: string | null;
    locations: unknown;
  }>(
    `SELECT
       u.id::text,
       u.email,
       u.role_id::text,
       ur.name AS role_name,
       COALESCE(
         json_agg(
           DISTINCT jsonb_build_object(
             'id', l.id::text,
             'code', l.code,
             'name', l.name
           )
         ) FILTER (WHERE l.id IS NOT NULL),
         '[]'::json
       ) AS locations
     FROM users u
     INNER JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1::uuid
     LEFT JOIN user_roles ur ON ur.id = u.role_id
     LEFT JOIN user_locations ul ON ul.user_id = u.id
     LEFT JOIN locations l ON l.id = ul.location_id AND l.tenant_id = $1::uuid
     GROUP BY u.id, u.email, u.role_id, ur.name
     ORDER BY lower(u.email) ASC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    email: row.email,
    role_id: row.role_id != null ? Number(row.role_id) : null,
    role_name: row.role_name,
    locations: Array.isArray(row.locations)
      ? (row.locations as { id: string; code: string; name: string }[])
      : [],
  }));
}

export async function createTenantUser(
  pool: Pool,
  tenantId: string,
  input: {
    email: string;
    password: string;
    roleId: number;
    locationIds: string[];
  },
): Promise<{ ok: true; id: string; generatedPassword?: string } | { ok: false; code: "email_taken" }> {
  const email = input.email.trim().toLowerCase();
  const dup = await pool.query(`SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
  if (dup.rows[0]) return { ok: false, code: "email_taken" };

  const hash = await bcrypt.hash(input.password, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role_id)
       VALUES ($1, $2, $3::int)
       RETURNING id::text`,
      [email, hash, input.roleId],
    );
    const uid = ins.rows[0]?.id;
    if (!uid) throw new Error("user insert failed");

    const mapped = await client.query<{ name: string }>(
      `SELECT name FROM user_roles WHERE id = $1::int LIMIT 1`,
      [input.roleId],
    );
    const roleName = mapped.rows[0]?.name ?? "";
    const sessionRole = sessionRoleFromUserRoleName(roleName) ?? "member";

    await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role)
       VALUES ($1::uuid, $2::uuid, $3)
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
      [uid, tenantId, sessionRole],
    );

    for (const lid of input.locationIds) {
      const ok = await client.query(
        `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
        [lid, tenantId],
      );
      if (ok.rows[0]) {
        await client.query(
          `INSERT INTO user_locations (user_id, location_id) VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [uid, lid],
        );
      }
    }

    await client.query("COMMIT");
    return { ok: true, id: uid };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function updateTenantUser(
  pool: Pool,
  tenantId: string,
  userId: string,
  input: { roleId: number; locationIds: string[]; email?: string },
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mem = await client.query(
      `SELECT 1 FROM memberships WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
      [userId, tenantId],
    );
    if (!mem.rows[0]) {
      throw new Error("user_not_in_tenant");
    }

    if (input.email?.trim()) {
      await client.query(`UPDATE users SET email = $2 WHERE id = $1::uuid`, [
        userId,
        input.email.trim().toLowerCase(),
      ]);
    }

    await client.query(`UPDATE users SET role_id = $2::int WHERE id = $1::uuid`, [
      userId,
      input.roleId,
    ]);

    const mapped = await client.query<{ name: string }>(
      `SELECT name FROM user_roles WHERE id = $1::int LIMIT 1`,
      [input.roleId],
    );
    const sessionRole = sessionRoleFromUserRoleName(mapped.rows[0]?.name ?? "") ?? "member";
    await client.query(
      `UPDATE memberships SET role = $3 WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
      [userId, tenantId, sessionRole],
    );

    await client.query(
      `DELETE FROM user_locations ul
       USING locations l
       WHERE ul.user_id = $1::uuid
         AND ul.location_id = l.id
         AND l.tenant_id = $2::uuid`,
      [userId, tenantId],
    );

    for (const lid of input.locationIds) {
      const ok = await client.query(
        `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
        [lid, tenantId],
      );
      if (ok.rows[0]) {
        await client.query(
          `INSERT INTO user_locations (user_id, location_id) VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [userId, lid],
        );
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function removeUserFromTenant(pool: Pool, tenantId: string, userId: string): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const del = await client.query(
      `DELETE FROM memberships WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
      [userId, tenantId],
    );
    await client.query(
      `DELETE FROM user_locations ul
       USING locations l
       WHERE ul.user_id = $1::uuid
         AND ul.location_id = l.id
         AND l.tenant_id = $2::uuid`,
      [userId, tenantId],
    );
    await client.query("COMMIT");
    return (del.rowCount ?? 0) > 0;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
