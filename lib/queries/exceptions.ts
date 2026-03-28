import type { Sql } from "@/lib/db";

export type ExceptionRow = {
  id: string;
  type: string;
  severity: string;
  state: string;
  detail: string;
  created_at: string;
};

export async function listExceptions(
  sql: Sql,
  tenantId: string,
  locationId: string,
): Promise<ExceptionRow[]> {
  const rows = await sql<
    {
      id: string;
      type: string;
      severity: string;
      state: string;
      detail: string;
      created_at: Date;
    }[]
  >`
    SELECT id, type, severity, state, detail, created_at
    FROM exceptions
    WHERE tenant_id = ${tenantId}::uuid AND location_id = ${locationId}::uuid
    ORDER BY created_at DESC
    LIMIT 200
  `;
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
  }));
}

export async function updateExceptionState(
  sql: Sql,
  tenantId: string,
  id: string,
  state: string,
  userId: string,
): Promise<boolean> {
  const resolved = state === "resolved" || state === "ignored";
  const [row] = await sql<{ id: string }[]>`
    UPDATE exceptions
    SET
      state = ${state},
      resolved_at = CASE WHEN ${resolved} THEN now() ELSE resolved_at END
    WHERE id = ${id}::uuid AND tenant_id = ${tenantId}::uuid
    RETURNING id
  `;
  if (!row) return false;
  await sql`
    INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
    VALUES (
      ${tenantId}::uuid,
      ${userId}::uuid,
      'exception_state',
      ${id},
      ${sql.json({ state })}
    )
  `;
  return true;
}
