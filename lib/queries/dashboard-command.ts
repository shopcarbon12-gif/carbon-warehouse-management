import type { Pool } from "pg";

export type CommandCenterKpis = {
  total_items: number;
  receiving_concerns: number;
  unknown_assets: number;
};

export type AuditLogListRow = {
  id: string;
  action: string;
  entity: string;
  metadata: unknown;
  created_at: string;
};

export async function getCommandCenterKpis(
  pool: Pool,
  locationId: string,
): Promise<CommandCenterKpis> {
  const total = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM items WHERE location_id = $1::uuid`,
    [locationId],
  );
  const incomplete = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM items
     WHERE location_id = $1::uuid AND status = 'pending_visibility'`,
    [locationId],
  );
  const unknown = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c FROM items
     WHERE location_id = $1::uuid AND status = 'UNKNOWN'`,
    [locationId],
  );
  return {
    total_items: Number(total.rows[0]?.c ?? 0),
    receiving_concerns: Number(incomplete.rows[0]?.c ?? 0),
    unknown_assets: Number(unknown.rows[0]?.c ?? 0),
  };
}

export async function listRecentAuditForTenant(
  pool: Pool,
  tenantId: string,
  limit: number,
): Promise<AuditLogListRow[]> {
  const r = await pool.query<{
    id: string;
    action: string;
    entity: string;
    metadata: unknown;
    created_at: Date;
  }>(
    `SELECT id, action, entity, metadata, created_at
     FROM audit_log
     WHERE tenant_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    action: row.action,
    entity: row.entity,
    metadata: row.metadata,
    created_at: row.created_at.toISOString(),
  }));
}
