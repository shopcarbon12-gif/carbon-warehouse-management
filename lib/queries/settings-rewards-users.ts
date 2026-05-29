import bcrypt from "bcryptjs";
import type { Pool } from "pg";

/**
 * Rewards (rewards.shopcarbon.com) credentials manager.
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
  /** Identity columns shared with the WMS + POS user list (lives on the
   *  shared `users` table, migration 040). */
  first_name: string | null;
  last_name: string | null;
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
    first_name: string | null;
    last_name: string | null;
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
       u.first_name,
       u.last_name,
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
    firstName?: string | null;
    lastName?: string | null;
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
  // first/last name on the shared `users` table — kept in sync across the
  // three Settings panels regardless of which one edited the row.
  if (input.firstName !== undefined) {
    await pool.query(`UPDATE users SET first_name = $2 WHERE id = $1::uuid`, [
      userId,
      input.firstName?.trim() || null,
    ]);
  }
  if (input.lastName !== undefined) {
    await pool.query(`UPDATE users SET last_name = $2 WHERE id = $1::uuid`, [
      userId,
      input.lastName?.trim() || null,
    ]);
  }
  return (r.rowCount ?? 0) > 0;
}

/**
 * Grant (or re-grant) rewards access to a person, keyed by email.
 *
 * Rewards access is a `rewards_employees` row attached to a shared `users`
 * row — it is NOT the same thing as being a WMS/POS user. So "add a rewards
 * user" means: find the existing `users` row by email (case-insensitive, the
 * same way the Carbon-Loyalty login resolves it) and UPSERT a rewards_employees
 * row onto it. Only when no user exists at all do we create one.
 *
 * This is idempotent: re-granting to someone who already has rewards access
 * updates their role, reactivates them, and (if a password was supplied)
 * resets the rewards password — it never errors with "email already exists".
 *
 * Three tables, one transaction:
 *   - users            — created ONLY for a brand-new email. An existing
 *                        user's WMS/POS password_hash is never touched.
 *   - memberships      — ensure a tenant membership exists so the user shows
 *                        in the rewards list (the list INNER JOINs memberships).
 *                        ON CONFLICT DO NOTHING so we never downgrade an
 *                        existing WMS admin's membership role to 'member'.
 *   - rewards_employees— UPSERT on the UNIQUE user_id: set role, reactivate,
 *                        and set the rewards password hash only when a password
 *                        was supplied (COALESCE preserves an existing hash on a
 *                        no-password re-grant — never blanks it).
 *
 * The `roleName` argument selects which seeded scope='rewards' role to assign
 * (defaults to "Manager"). Defensive guard: rejects role names containing
 * "warehouse" — rewards has no warehouse concept (Super Admin + Manager only).
 */
export async function createTenantRewardsUser(
  pool: Pool,
  tenantId: string,
  input: {
    email: string;
    password?: string;
    roleName?: "Super Admin" | "Manager";
    firstName?: string | null;
    lastName?: string | null;
  },
): Promise<
  | { ok: true; id: string; userCreated: boolean; rewardsCreated: boolean }
  | {
      ok: false;
      code:
        | "rewards_employees_missing"
        | "role_missing"
        | "role_not_allowed"
        | "password_required";
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
  const password = input.password?.trim() || "";

  const role = await pool.query<{ id: number }>(
    `SELECT id FROM user_roles WHERE name = $1 AND scope = 'rewards' LIMIT 1`,
    [roleName],
  );
  const roleId = role.rows[0]?.id;
  if (!roleId) return { ok: false, code: "role_missing" };

  // Hash only when a password was actually supplied. null = "leave whatever
  // hash is already there" (COALESCE'd into the UPSERT below).
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Resolve the target user the same way the rewards login does.
    const found = await client.query<{ id: string }>(
      `SELECT id::text FROM users WHERE lower(email) = lower($1) LIMIT 1`,
      [email],
    );
    let uid = found.rows[0]?.id ?? null;
    let userCreated = false;

    if (!uid) {
      // Brand-new person: we must set users.password_hash (NOT NULL) and the
      // rewards login needs a hash too — so a password is required here.
      if (!passwordHash) {
        await client.query("ROLLBACK");
        return { ok: false, code: "password_required" };
      }
      const ins = await client.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, first_name, last_name)
         VALUES ($1, $2, $3, $4)
         RETURNING id::text`,
        [
          email,
          passwordHash,
          input.firstName?.trim() || null,
          input.lastName?.trim() || null,
        ],
      );
      uid = ins.rows[0]?.id ?? null;
      if (!uid) throw new Error("user insert failed");
      userCreated = true;
    } else {
      // Existing user — fill in identity columns if they were blank, but never
      // overwrite an existing name and never touch their WMS/POS password.
      await client.query(
        `UPDATE users
            SET first_name = COALESCE(first_name, $2),
                last_name  = COALESCE(last_name, $3)
          WHERE id = $1::uuid`,
        [uid, input.firstName?.trim() || null, input.lastName?.trim() || null],
      );
    }

    // Ensure a tenant membership exists (so they appear in the rewards list),
    // but DO NOT change an existing membership — that would clobber a WMS
    // admin's role.
    await client.query(
      `INSERT INTO memberships (user_id, tenant_id, role)
       VALUES ($1::uuid, $2::uuid, 'member')
       ON CONFLICT (user_id, tenant_id) DO NOTHING`,
      [uid, tenantId],
    );

    // Attach / re-grant rewards access. xmax = 0 distinguishes a fresh INSERT
    // from a DO UPDATE so the caller can report created-vs-updated.
    const re = await client.query<{ rewards_created: boolean }>(
      `INSERT INTO rewards_employees (user_id, rewards_role_id, rewards_password_hash, is_active)
       VALUES ($1::uuid, $2::int, $3, TRUE)
       ON CONFLICT (user_id) DO UPDATE SET
         rewards_role_id       = EXCLUDED.rewards_role_id,
         rewards_password_hash = COALESCE(EXCLUDED.rewards_password_hash,
                                          rewards_employees.rewards_password_hash),
         is_active             = TRUE,
         updated_at            = now()
       RETURNING (xmax = 0) AS rewards_created`,
      [uid, roleId, passwordHash],
    );

    await client.query("COMMIT");
    return {
      ok: true,
      id: uid,
      userCreated,
      rewardsCreated: re.rows[0]?.rewards_created ?? false,
    };
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
