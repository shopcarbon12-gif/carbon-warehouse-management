import bcrypt from "bcryptjs";
import type { Sql } from "@/lib/db";
import type { SessionPayload } from "@/lib/auth";

export async function findUserWithTenantLocation(
  sql: Sql,
  email: string,
  password: string,
): Promise<SessionPayload | null> {
  const [user] = await sql<{ id: string; password_hash: string }[]>`
    SELECT id, password_hash FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `;
  if (!user) return null;
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return null;

  const [row] = await sql<{ tid: string; lid: string }[]>`
    SELECT m.tenant_id AS tid, l.id AS lid
    FROM memberships m
    JOIN locations l ON l.tenant_id = m.tenant_id
    WHERE m.user_id = ${user.id}
    ORDER BY l.code ASC
    LIMIT 1
  `;
  if (!row) return null;

  return {
    sub: user.id,
    email,
    tid: row.tid,
    lid: row.lid,
  };
}

export async function assertLocationForTenant(
  sql: Sql,
  tenantId: string,
  locationId: string,
): Promise<boolean> {
  const [row] = await sql<{ ok: number }[]>`
    SELECT 1 AS ok FROM locations
    WHERE id = ${locationId}::uuid AND tenant_id = ${tenantId}::uuid
    LIMIT 1
  `;
  return row != null;
}
