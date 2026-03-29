import bcrypt from "bcryptjs";
import type { Pool } from "pg";
import type { SessionPayload } from "@/lib/auth";

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
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;

  const loc = await pool.query<{ tid: string; lid: string; role: string }>(
    `SELECT m.tenant_id AS tid, l.id AS lid, m.role
     FROM memberships m
     JOIN locations l ON l.tenant_id = m.tenant_id
     WHERE m.user_id = $1::uuid
     ORDER BY l.code ASC
     LIMIT 1`,
    [user.id],
  );
  const row = loc.rows[0];
  if (!row) return null;

  return {
    sub: user.id,
    email,
    tid: row.tid,
    lid: row.lid,
    role: row.role?.trim() || "member",
  };
}

export async function assertLocationForTenant(
  pool: Pool,
  tenantId: string,
  locationId: string,
): Promise<boolean> {
  const r = await pool.query<{ ok: number }>(
    `SELECT 1 AS ok FROM locations
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [locationId, tenantId],
  );
  return r.rows[0] != null;
}
