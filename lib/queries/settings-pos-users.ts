import bcrypt from "bcryptjs";
import type { Pool } from "pg";

export type PosUserListRow = {
  /** users.id (UUID, text). The "POS user" is identified by user_id. */
  id: string;
  email: string;
  /** pos_employees.id (SERIAL). Null if the user has no pos_employees row yet. */
  pos_employee_id: number | null;
  pos_role_id: number | null;
  pos_role_name: string | null;
  /** Free-text legacy role on pos_employees (cashier|supervisor|manager|admin). */
  legacy_role: string | null;
  is_active: boolean;
  has_pin: boolean;
  /** True iff pos_employees.pos_password_hash is set — i.e. POS has its own
   *  password independent of the WMS users.password_hash. False on legacy rows
   *  whose POS auth still falls back to users.password_hash. */
  has_pos_password: boolean;
  locations: { id: string; code: string; name: string }[];
};

/**
 * List POS users for a tenant. A "POS user" is any users row that has a
 * pos_employees row in the shared DB. Filters by tenant via the user's
 * memberships row so admins on tenant A don't see cashiers on tenant B.
 *
 * Returns an empty list if the pos_employees table doesn't exist in this
 * database — that happens before the POS schema migration has been run
 * locally and we don't want to crash the settings page over it.
 */
export async function listTenantPosUsers(
  pool: Pool,
  tenantId: string,
): Promise<PosUserListRow[]> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.pos_employees') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return [];

  // Whether the pos_role_id column has been added (migration 0057).
  const hasPosRoleId = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pos_employees' AND column_name = 'pos_role_id'
     ) AS exists`,
  );
  const posRoleSelect = hasPosRoleId.rows[0]?.exists
    ? "pe.pos_role_id"
    : "NULL::int AS pos_role_id";
  const posRoleJoin = hasPosRoleId.rows[0]?.exists
    ? "LEFT JOIN user_roles ur ON ur.id = pe.pos_role_id AND ur.scope = 'pos'"
    : "";
  const posRoleNameSelect = hasPosRoleId.rows[0]?.exists ? "ur.name" : "NULL::text";

  // Whether the pos_password_hash column has been added (migration 0058).
  const hasPosPwd = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pos_employees' AND column_name = 'pos_password_hash'
     ) AS exists`,
  );
  const hasPosPwdSelect = hasPosPwd.rows[0]?.exists
    ? "(pe.pos_password_hash IS NOT NULL AND length(pe.pos_password_hash) > 0) AS has_pos_password"
    : "FALSE AS has_pos_password";
  const groupExtras = [
    hasPosRoleId.rows[0]?.exists ? "pe.pos_role_id, ur.name" : "",
    hasPosPwd.rows[0]?.exists ? "pe.pos_password_hash" : "",
  ]
    .filter((s) => s.length > 0)
    .join(", ");

  const r = await pool.query<{
    id: string;
    email: string;
    pos_employee_id: number | null;
    pos_role_id: number | null;
    pos_role_name: string | null;
    legacy_role: string | null;
    is_active: boolean;
    has_pin: boolean;
    has_pos_password: boolean;
    locations: unknown;
  }>(
    `SELECT
       u.id::text,
       u.email,
       pe.id           AS pos_employee_id,
       ${posRoleSelect},
       ${posRoleNameSelect} AS pos_role_name,
       pe.role         AS legacy_role,
       pe.is_active,
       (pe.pin_hash IS NOT NULL AND length(pe.pin_hash) > 0) AS has_pin,
       ${hasPosPwdSelect},
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
     FROM pos_employees pe
     INNER JOIN users u        ON u.id = pe.user_id
     INNER JOIN memberships m  ON m.user_id = u.id AND m.tenant_id = $1::uuid
     ${posRoleJoin}
     LEFT JOIN user_locations ul ON ul.user_id = u.id
     LEFT JOIN locations l       ON l.id = ul.location_id AND l.tenant_id = $1::uuid
     GROUP BY u.id, u.email, pe.id, ${groupExtras ? groupExtras + "," : ""} pe.role, pe.is_active, pe.pin_hash
     ORDER BY lower(u.email) ASC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    email: row.email,
    pos_employee_id: row.pos_employee_id,
    pos_role_id: row.pos_role_id,
    pos_role_name: row.pos_role_name,
    legacy_role: row.legacy_role,
    is_active: row.is_active,
    has_pin: row.has_pin,
    has_pos_password: row.has_pos_password,
    locations: Array.isArray(row.locations)
      ? (row.locations as { id: string; code: string; name: string }[])
      : [],
  }));
}

/**
 * Update a POS user's role and active flag. Optionally resets the PIN and/or
 * the POS password.
 *
 * `resetPassword` writes ONLY to pos_employees.pos_password_hash. The user's
 * WMS login (users.password_hash) is intentionally not touched — this is the
 * whole point of the per-user POS password column added by migration 0058.
 *
 * Returns false if the user has no pos_employees row in the shared DB.
 */
export async function updateTenantPosUser(
  pool: Pool,
  tenantId: string,
  userId: string,
  input: {
    posRoleId: number | null;
    isActive: boolean;
    resetPin?: string;
    resetPassword?: string;
  },
): Promise<boolean> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.pos_employees') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return false;

  // Ensure the user belongs to this tenant before mutating their pos row.
  const ok = await pool.query(
    `SELECT 1
       FROM users u
       JOIN memberships m ON m.user_id = u.id
      WHERE u.id = $1::uuid AND m.tenant_id = $2::uuid
      LIMIT 1`,
    [userId, tenantId],
  );
  if (!ok.rows[0]) return false;

  const hasPosRoleId = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pos_employees' AND column_name = 'pos_role_id'
     ) AS exists`,
  );
  const hasPosPwd = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_name = 'pos_employees' AND column_name = 'pos_password_hash'
     ) AS exists`,
  );

  const fields: string[] = ["is_active = $2::boolean"];
  const params: unknown[] = [userId, input.isActive];
  if (hasPosRoleId.rows[0]?.exists) {
    params.push(input.posRoleId);
    fields.push(`pos_role_id = $${params.length}::int`);
  }
  if (input.resetPin && /^\d{4}$/.test(input.resetPin)) {
    const hash = await bcrypt.hash(input.resetPin, 10);
    params.push(hash);
    fields.push(`pin_hash = $${params.length}`);
  }
  if (
    input.resetPassword &&
    input.resetPassword.length >= 6 &&
    hasPosPwd.rows[0]?.exists
  ) {
    const hash = await bcrypt.hash(input.resetPassword, 10);
    params.push(hash);
    fields.push(`pos_password_hash = $${params.length}`);
  }

  const r = await pool.query(
    `UPDATE pos_employees SET ${fields.join(", ")} WHERE user_id = $1::uuid`,
    params,
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Create a POS *Manager* for a location. This is the only place a POS manager
 * is provisioned — once they exist, they sign into the POS and add cashiers
 * from there. Creates `users` + `memberships` + `user_locations` +
 * `pos_employees` (with pos_role_id pointing at the seeded "Manager" POS
 * role) atomically.
 */
export async function createTenantPosManager(
  pool: Pool,
  tenantId: string,
  input: {
    email: string;
    password: string;
    pin: string;
    locationId: string;
  },
): Promise<
  | { ok: true; id: string }
  | { ok: false; code: "email_taken" | "pos_employees_missing" | "manager_role_missing" | "location_invalid" }
> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.pos_employees') IS NOT NULL AS exists`,
  );
  if (!exists.rows[0]?.exists) return { ok: false, code: "pos_employees_missing" };

  if (!/^\d{4}$/.test(input.pin)) {
    throw new Error("BAD_REQUEST:PIN must be 4 digits");
  }

  const email = input.email.trim().toLowerCase();
  const dup = await pool.query(
    `SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email],
  );
  if (dup.rows[0]) return { ok: false, code: "email_taken" };

  const role = await pool.query<{ id: number }>(
    `SELECT id FROM user_roles WHERE name = 'Manager' AND scope = 'pos' LIMIT 1`,
  );
  const managerRoleId = role.rows[0]?.id;
  if (!managerRoleId) return { ok: false, code: "manager_role_missing" };

  // Belt-and-suspenders: double-check the location belongs to this tenant
  // BEFORE we start inserting users (cheaper rollback).
  const locOk = await pool.query(
    `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [input.locationId, tenantId],
  );
  if (!locOk.rows[0]) return { ok: false, code: "location_invalid" };

  const passwordHash = await bcrypt.hash(input.password, 10);
  const pinHash = await bcrypt.hash(input.pin, 10);

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
      `INSERT INTO user_locations (user_id, location_id)
       VALUES ($1::uuid, $2::uuid)
       ON CONFLICT DO NOTHING`,
      [uid, input.locationId],
    );

    // Initialise BOTH columns to the same hash. users.password_hash continues
    // to drive WMS login; pos_password_hash will drive POS login once the POS
    // auth path has been flipped to read from it. After that point an admin
    // can reset either one independently from the WMS UI.
    const hasPosPwd = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'pos_employees' AND column_name = 'pos_password_hash'
       ) AS exists`,
    );
    if (hasPosPwd.rows[0]?.exists) {
      await client.query(
        `INSERT INTO pos_employees (user_id, pin_hash, role, is_active, pos_role_id, pos_password_hash)
         VALUES ($1::uuid, $2, 'manager', TRUE, $3::int, $4)`,
        [uid, pinHash, managerRoleId, passwordHash],
      );
    } else {
      await client.query(
        `INSERT INTO pos_employees (user_id, pin_hash, role, is_active, pos_role_id)
         VALUES ($1::uuid, $2, 'manager', TRUE, $3::int)`,
        [uid, pinHash, managerRoleId],
      );
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

/**
 * Soft-detach a POS user: marks pos_employees.is_active = false. We don't
 * delete the row outright because past sales reference cashier_id and need
 * the historical link.
 */
export async function deactivateTenantPosUser(
  pool: Pool,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const exists = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.pos_employees') IS NOT NULL AS exists`,
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

  const r = await pool.query(
    `UPDATE pos_employees SET is_active = FALSE WHERE user_id = $1::uuid`,
    [userId],
  );
  return (r.rowCount ?? 0) > 0;
}
