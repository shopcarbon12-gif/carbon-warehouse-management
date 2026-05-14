import bcrypt from "bcryptjs";
import type { Pool } from "pg";

/**
 * Rewards (loyalty.shopcarbon.com) credentials manager.
 *
 * Mirrors the shape of settings-pos-users.ts but simpler — rewards has no
 * PIN concept and no per-location scoping. A "rewards user" is any users row
 * that has a rewards_employees row in the shared DB.
 *
 * Authentication target is Carbon-Loyalty (shared Postgres). Login = email +
 * rewards_password_hash. Authorization = rewards_role_id (a user_roles row
 * with scope='rewards' — seeded "Super Admin" + "Manager" by migration 0079).
 */

export type RewardsUserListRow = {
  /** users.id (UUID, text). */
  id: string;
  email: string;
  /** rewards_employees.id (SERIAL). Null means no rewards row yet. */
  rewards_employee_id: number | null;
  rewards_role_id: number | null;
  rewards_role_name: string | null;
  is_active: boolean;
  has_rewards_password: boolean;
  created_at: string | null;
};

export async function listTenantRewardsUsers(
  pool: Pool,
  tenantId: string,
): Promise<RewardsUserListRow[]> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.rewards_employees') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return [];

  const r = await pool.query<{
    id: string;
    email: string;
    rewards_employee_id: number | null;
    rewards_role_id: number | null;
    rewards_role_name: string | null;
    is_active: boolean;
    has_rewards_password: boolean;
    created_at: string | null;
  }>(
    `SELECT
       u.id::text,
       u.email,
       re.id                  AS rewards_employee_id,
       re.rewards_role_id,
       ur.name                AS rewards_role_name,
       re.is_active,
       (re.rewards_password_hash IS NOT NULL AND length(re.rewards_password_hash) > 0)
                              AS has_rewards_password,
       re.created_at::text    AS created_at
     FROM rewards_employees re
     INNER JOIN users u        ON u.id = re.user_id
     INNER JOIN memberships m  ON m.user_id = u.id AND m.tenant_id = $1::uuid
     LEFT JOIN user_roles ur   ON ur.id = re.rewards_role_id AND ur.scope = 'rewards'
     ORDER BY lower(u.email) ASC`,
    [tenantId],
  );
  return r.rows;
}

export async function updateTenantRewardsUser(
  pool: Pool,
  tenantId: string,
  userId: string,
  input: {
    rewardsRoleId: number | null;
    isActive: boolean;
    resetPassword?: string;
  },
): Promise<boolean> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.rewards_employees') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return false;

  const ok = await pool.query(
    `SELECT 1
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.id = $1::uuid AND m.tenant_id = $2::uuid
      LIMIT 1`,
    [userId, tenantId],
  );
  if (!ok.rows[0]) return false;

  const fields = ["is_active = $2::boolean", "updated_at = now()"];
  const params: unknown[] = [userId, input.isActive];
  params.push(input.rewardsRoleId);
  fields.push(`rewards_role_id = $${params.length}::int`);
  if (input.resetPassword && input.resetPassword.length >= 6) {
    const hash = await bcrypt.hash(input.resetPassword, 10);
    params.push(hash);
    fields.push(`rewards_password_hash = $${params.length}`);
  }

  const r = await pool.query(
    `UPDATE rewards_employees SET ${fields.join(", ")} WHERE user_id = $1::uuid`,
    params,
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Provision a rewards user — creates `users` + `memberships` + `rewards_employees`
 * atomically. The `roleName` argument selects which seeded scope='rewards'
 * role to assign (defaults to "Manager").
 *
 * Defensive guard: rejects role names containing "warehouse" (case-insensitive)
 * — rewards has no warehouse concept and the user explicitly asked for only
 * Super Admin + Manager.
 */
export async function createTenantRewardsUser(
  pool: Pool,
  tenantId: string,
  input: {
    email: string;
    password: string;
    roleName?: "Super Admin" | "Manager";
  },
): Promise<
  | { ok: true; id: string }
  | {
      ok: false;
      code:
        | "email_taken"
        | "rewards_employees_missing"
        | "role_missing"
        | "role_not_allowed";
    }
> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.rewards_employees') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return { ok: false, code: "rewards_employees_missing" };

  const roleName = input.roleName ?? "Manager";
  if (/warehouse/i.test(roleName)) {
    return { ok: false, code: "role_not_allowed" };
  }

  const email = input.email.trim().toLowerCase();
  const dup = await pool.query(
    `SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  if (dup.rows[0]) return { ok: false, code: "email_taken" };

  const role = await pool.query<{ id: number }>(
    `SELECT id FROM user_roles WHERE name = $1 AND scope = 'rewards' LIMIT 1`,
    [roleName],
  );
  const roleId = role.rows[0]?.id;
  if (!roleId) return { ok: false, code: "role_missing" };

  const passwordHash = await bcrypt.hash(input.password, 10);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id::text`,
      [email, passwordHash],
    );
    const uid = ins.rows[0]?.id;
    if (!uid) throw new Error("user insert failed");

    await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role)
       VALUES ($1::uuid, $2::uuid, 'member')
       ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role`,
      [uid, tenantId],
    );

    await client.query(
      `INSERT INTO rewards_employees (user_id, rewards_role_id, rewards_password_hash, is_active)
       VALUES ($1::uuid, $2::int, $3, TRUE)`,
      [uid, roleId, passwordHash],
    );

    await client.query("COMMIT");
    return { ok: true, id: uid };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deactivateTenantRewardsUser(
  pool: Pool,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const ok = await pool.query(
    `SELECT 1
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.id = $1::uuid AND m.tenant_id = $2::uuid
      LIMIT 1`,
    [userId, tenantId],
  );
  if (!ok.rows[0]) return false;
  const r = await pool.query(
    `UPDATE rewards_employees SET is_active = FALSE, updated_at = now() WHERE user_id = $1::uuid`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}
