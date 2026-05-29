import bcrypt from "bcryptjs";
import type { Pool } from "pg";
import { sessionRoleFromUserRoleName } from "@/lib/auth/user-role-map";

export type TenantUserListRow = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  role_id: number | null;
  role_name: string | null;
  /** Optional WMS Mobile (handheld) role — scope='mobile' user_roles row. */
  mobile_role_id: number | null;
  mobile_role_name: string | null;
  locations: { id: string; code: string; name: string }[];
};

export async function listTenantUsers(
  pool: Pool,
  tenantId: string,
): Promise<TenantUserListRow[]> {
  const r = await pool.query<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    role_id: string | null;
    role_name: string | null;
    mobile_role_id: string | null;
    mobile_role_name: string | null;
    locations: unknown;
  }>(
    `SELECT
       u.id::text,
       u.email,
       u.first_name,
       u.last_name,
       u.role_id::text,
       ur.name AS role_name,
       u.mobile_role_id::text,
       mr.name AS mobile_role_name,
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
     LEFT JOIN user_roles mr ON mr.id = u.mobile_role_id
     LEFT JOIN user_locations ul ON ul.user_id = u.id
     LEFT JOIN locations l ON l.id = ul.location_id AND l.tenant_id = $1::uuid
     GROUP BY u.id, u.email, u.first_name, u.last_name, u.role_id, ur.name, u.mobile_role_id, mr.name
     ORDER BY lower(u.email) ASC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    role_id: row.role_id != null ? Number(row.role_id) : null,
    role_name: row.role_name,
    mobile_role_id: row.mobile_role_id != null ? Number(row.mobile_role_id) : null,
    mobile_role_name: row.mobile_role_name,
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
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<{ ok: true; id: string; generatedPassword?: string } | { ok: false; code: "email_taken" }> {
  const email = input.email.trim().toLowerCase();
  const firstName = input.firstName?.trim() || null;
  const lastName = input.lastName?.trim() || null;
  const dup = await pool.query(`SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1`, [email]);
  if (dup.rows[0]) return { ok: false, code: "email_taken" };

  const hash = await bcrypt.hash(input.password, 10);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, role_id, first_name, last_name)
       VALUES ($1, $2, $3::int, $4, $5)
       RETURNING id::text`,
      [email, hash, input.roleId, firstName, lastName],
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
  input: {
    roleId: number;
    locationIds: string[];
    email?: string;
    firstName?: string | null;
    lastName?: string | null;
  },
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

    // first/last name are independent of role/email — only write when the
    // caller actually passed them (undefined = leave the column alone;
    // explicit null/empty-string = clear it).
    if (input.firstName !== undefined) {
      const fn = input.firstName?.trim() || null;
      await client.query(`UPDATE users SET first_name = $2 WHERE id = $1::uuid`, [userId, fn]);
    }
    if (input.lastName !== undefined) {
      const ln = input.lastName?.trim() || null;
      await client.query(`UPDATE users SET last_name = $2 WHERE id = $1::uuid`, [userId, ln]);
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
