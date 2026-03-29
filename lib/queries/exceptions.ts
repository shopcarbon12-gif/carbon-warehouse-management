import type { Pool } from "pg";

export type ExceptionRow = {
  id: string;
  type: string;
  severity: string;
  state: string;
  detail: string;
  created_at: string;
};

export async function listExceptions(
  pool: Pool,
  tenantId: string,
  locationId: string,
): Promise<ExceptionRow[]> {
  const r = await pool.query<{
    id: string;
    type: string;
    severity: string;
    state: string;
    detail: string;
    created_at: Date;
  }>(
    `SELECT id, type, severity, state, detail, created_at
     FROM exceptions
     WHERE tenant_id = $1::uuid AND location_id = $2::uuid
     ORDER BY created_at DESC
     LIMIT 200`,
    [tenantId, locationId],
  );
  return r.rows.map((row) => ({
    ...row,
    created_at: row.created_at.toISOString(),
  }));
}

export async function updateExceptionState(
  pool: Pool,
  tenantId: string,
  id: string,
  state: string,
  userId: string,
): Promise<boolean> {
  const resolved = state === "resolved" || state === "ignored";
  const upd = await pool.query<{ id: string }>(
    `UPDATE exceptions
     SET
       state = $1,
       resolved_at = CASE WHEN $2 THEN now() ELSE resolved_at END
     WHERE id = $3::uuid AND tenant_id = $4::uuid
     RETURNING id`,
    [state, resolved, id, tenantId],
  );
  if (!upd.rows[0]) return false;
  await pool.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'exception_state', $3, $4::jsonb)`,
    [tenantId, userId, id, JSON.stringify({ state })],
  );
  return true;
}
