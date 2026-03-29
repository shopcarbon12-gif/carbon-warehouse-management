import type { Pool } from "pg";

export async function getMembershipRole(
  pool: Pool,
  userId: string,
  tenantId: string,
): Promise<string | null> {
  const r = await pool.query<{ role: string }>(
    `SELECT role FROM memberships
     WHERE user_id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [userId, tenantId],
  );
  return r.rows[0]?.role?.trim() ?? null;
}
