import type { Pool } from "pg";

export type InventoryAuditLogRow = {
  id: number;
  log_type: string;
  entity_type: string;
  entity_reference: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  user_id: number | null;
  created_at: string;
};

export type AssetMovementRow = {
  id: number;
  epc: string;
  from_location: string | null;
  to_location: string;
  user_id: number | null;
  created_at: string;
};

export type ReplenishmentLogRow = {
  id: number;
  sku: string;
  qty: number;
  from_bin: string;
  to_bin: string;
  status: string;
  created_at: string;
};

export type ExternalSystemLogRow = {
  id: number;
  system_name: string;
  direction: string;
  payload_summary: string | null;
  status: string;
  created_at: string;
};

export async function listInventoryAuditLogs(
  pool: Pool,
  tenantId: string,
  opts: { logTypes?: string[]; search?: string; limit?: number },
): Promise<InventoryAuditLogRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  const conditions: string[] = ["tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  let p = 2;

  if (opts.logTypes?.length) {
    conditions.push(`log_type = ANY($${p}::text[])`);
    params.push(opts.logTypes);
    p++;
  }

  if (opts.search?.trim()) {
    conditions.push(`entity_reference ILIKE $${p}`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }

  params.push(limit);
  const r = await pool.query<{
    id: string;
    log_type: string;
    entity_type: string;
    entity_reference: string;
    old_value: string | null;
    new_value: string | null;
    reason: string | null;
    user_id: number | null;
    created_at: Date;
  }>(
    `SELECT id::text, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, created_at
     FROM inventory_audit_logs
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${p}`,
    params,
  );

  return r.rows.map((row) => ({
    id: Number(row.id),
    log_type: row.log_type,
    entity_type: row.entity_type,
    entity_reference: row.entity_reference,
    old_value: row.old_value,
    new_value: row.new_value,
    reason: row.reason,
    user_id: row.user_id,
    created_at: row.created_at.toISOString(),
  }));
}

export async function listAssetMovements(
  pool: Pool,
  tenantId: string,
  opts: { search?: string; limit?: number },
): Promise<AssetMovementRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  const conditions: string[] = ["tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  let p = 2;

  if (opts.search?.trim()) {
    conditions.push(`epc ILIKE $${p}`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }

  params.push(limit);
  const r = await pool.query<{
    id: string;
    epc: string;
    from_location: string | null;
    to_location: string;
    user_id: number | null;
    created_at: Date;
  }>(
    `SELECT id::text, epc, from_location, to_location, user_id, created_at
     FROM asset_movements
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${p}`,
    params,
  );

  return r.rows.map((row) => ({
    id: Number(row.id),
    epc: row.epc,
    from_location: row.from_location,
    to_location: row.to_location,
    user_id: row.user_id,
    created_at: row.created_at.toISOString(),
  }));
}

export async function listReplenishmentLogs(
  pool: Pool,
  tenantId: string,
  opts: { search?: string; limit?: number },
): Promise<ReplenishmentLogRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  const conditions: string[] = ["tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  let p = 2;

  if (opts.search?.trim()) {
    conditions.push(`sku ILIKE $${p}`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }

  params.push(limit);
  const r = await pool.query<{
    id: string;
    sku: string;
    qty: string;
    from_bin: string;
    to_bin: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id::text, sku, qty::text, from_bin, to_bin, status, created_at
     FROM replenishment_logs
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${p}`,
    params,
  );

  return r.rows.map((row) => ({
    id: Number(row.id),
    sku: row.sku,
    qty: Number(row.qty),
    from_bin: row.from_bin,
    to_bin: row.to_bin,
    status: row.status,
    created_at: row.created_at.toISOString(),
  }));
}

export async function listExternalSystemLogs(
  pool: Pool,
  tenantId: string,
  opts: { search?: string; limit?: number },
): Promise<ExternalSystemLogRow[]> {
  const limit = Math.min(opts.limit ?? 200, 500);
  const conditions: string[] = ["tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  let p = 2;

  if (opts.search?.trim()) {
    conditions.push(
      `(system_name ILIKE $${p} OR COALESCE(payload_summary, '') ILIKE $${p})`,
    );
    const q = `%${opts.search.trim()}%`;
    params.push(q);
    p++;
  }

  params.push(limit);
  const r = await pool.query<{
    id: string;
    system_name: string;
    direction: string;
    payload_summary: string | null;
    status: string;
    created_at: Date;
  }>(
    `SELECT id::text, system_name, direction, payload_summary, status, created_at
     FROM external_system_logs
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${p}`,
    params,
  );

  return r.rows.map((row) => ({
    id: Number(row.id),
    system_name: row.system_name,
    direction: row.direction,
    payload_summary: row.payload_summary,
    status: row.status,
    created_at: row.created_at.toISOString(),
  }));
}
