import type { Pool } from "pg";

type CreatedAtRangeOpts = { dateFrom?: string; dateTo?: string };

function appendCreatedAtRange(
  conditions: string[],
  params: unknown[],
  startP: number,
  opts: CreatedAtRangeOpts,
): number {
  let p = startP;
  if (opts.dateFrom) {
    conditions.push(`created_at >= $${p}::date`);
    params.push(opts.dateFrom);
    p++;
  }
  if (opts.dateTo) {
    conditions.push(`created_at < ($${p}::date + interval '1 day')`);
    params.push(opts.dateTo);
    p++;
  }
  return p;
}

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
  opts: { logTypes?: string[]; search?: string; limit?: number; dateFrom?: string; dateTo?: string },
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

  p = appendCreatedAtRange(conditions, params, p, opts);

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
  opts: { search?: string; limit?: number; dateFrom?: string; dateTo?: string },
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

  p = appendCreatedAtRange(conditions, params, p, opts);

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
  opts: { search?: string; limit?: number; dateFrom?: string; dateTo?: string },
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

  p = appendCreatedAtRange(conditions, params, p, opts);

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

/* ---------- inventory_reports (count-session audit archive) ---------- */

export type CountSessionReportRow = {
  id: string;
  activity: string;
  uploaded_at: string;
  uploaded_by: string | null;
  /// Convenience join — `users.email` for the row's `uploaded_by`. Null for
  /// edge-key (deviceId-authed) uploads where there's no logged-in user.
  uploaded_by_email: string | null;
  device_id: string | null;
  override_catalog: boolean;
  row_count: number;
  filename: string;
  expires_at: string;
};

export type CountSessionReportInsert = {
  tenantId: string;
  activity: string;
  uploadedAt: Date;
  uploadedBy: string | null;
  deviceId: string | null;
  overrideCatalog: boolean;
  rowCount: number;
  csvContent: string;
  filename: string;
};

export async function insertCountSessionReport(
  pool: Pool,
  input: CountSessionReportInsert,
): Promise<CountSessionReportRow> {
  const r = await pool.query<{
    id: string;
    activity: string;
    uploaded_at: Date;
    uploaded_by: string | null;
    device_id: string | null;
    override_catalog: boolean;
    row_count: number;
    filename: string;
    expires_at: Date;
  }>(
    `INSERT INTO inventory_reports
       (tenant_id, activity, uploaded_at, uploaded_by, device_id,
        override_catalog, row_count, csv_content, filename, expires_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9,
             ($3::timestamptz + interval '1 year'))
     RETURNING id::text, activity, uploaded_at, uploaded_by, device_id,
               override_catalog, row_count, filename, expires_at`,
    [
      input.tenantId,
      input.activity,
      input.uploadedAt,
      input.uploadedBy,
      input.deviceId,
      input.overrideCatalog,
      input.rowCount,
      input.csvContent,
      input.filename,
    ],
  );
  const row = r.rows[0];
  if (!row) throw new Error("insert inventory_reports failed");
  return {
    id: row.id,
    activity: row.activity,
    uploaded_at: row.uploaded_at.toISOString(),
    uploaded_by: row.uploaded_by,
    // Insert path doesn't JOIN to users — caller can re-fetch via the
    // list endpoint when they need the email. Returning null here keeps
    // the type narrow; list path populates it via the second-pass lookup.
    uploaded_by_email: null,
    device_id: row.device_id,
    override_catalog: row.override_catalog,
    row_count: row.row_count,
    filename: row.filename,
    expires_at: row.expires_at.toISOString(),
  };
}

export type CountSessionReportListOpts = {
  activity?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
};

export async function listCountSessionReports(
  pool: Pool,
  tenantId: string,
  opts: CountSessionReportListOpts,
): Promise<{ rows: CountSessionReportRow[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const limit = Math.min(opts.limit ?? 25, 100);
  const offset = (page - 1) * limit;

  const conditions: string[] = ["tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];
  let p = 2;

  if (opts.activity?.trim()) {
    conditions.push(`activity = $${p}`);
    params.push(opts.activity.trim());
    p++;
  }
  if (opts.search?.trim()) {
    conditions.push(`filename ILIKE $${p}`);
    params.push(`%${opts.search.trim()}%`);
    p++;
  }
  if (opts.dateFrom) {
    conditions.push(`uploaded_at >= $${p}::date`);
    params.push(opts.dateFrom);
    p++;
  }
  if (opts.dateTo) {
    conditions.push(`uploaded_at < ($${p}::date + interval '1 day')`);
    params.push(opts.dateTo);
    p++;
  }

  const whereSql = conditions.join(" AND ");

  const countR = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM inventory_reports WHERE ${whereSql}`,
    params,
  );
  const total = Number(countR.rows[0]?.c ?? 0);

  params.push(limit, offset);
  const r = await pool.query<{
    id: string;
    activity: string;
    uploaded_at: Date;
    uploaded_by: string | null;
    device_id: string | null;
    override_catalog: boolean;
    row_count: number;
    filename: string;
    expires_at: Date;
  }>(
    `SELECT id::text, activity, uploaded_at, uploaded_by, device_id,
            override_catalog, row_count, filename, expires_at
     FROM inventory_reports
     WHERE ${whereSql}
     ORDER BY uploaded_at DESC
     LIMIT $${p} OFFSET $${p + 1}`,
    params,
  );

  // Second-pass user-email lookup. Kept out of the main query so the existing
  // WHERE clause builder doesn't need to qualify every column with `ir.` (and
  // doesn't risk `tenant_id` ambiguity now that we'd be joining `users`).
  // Edge-key uploads have uploaded_by=NULL → no row in this map.
  const userIds = Array.from(
    new Set(r.rows.map((row) => row.uploaded_by).filter((v): v is string => !!v)),
  );
  const emails = new Map<string, string>();
  if (userIds.length > 0) {
    try {
      const er = await pool.query<{ id: string; email: string }>(
        `SELECT id::text, email FROM users WHERE id = ANY($1::uuid[])`,
        [userIds],
      );
      for (const row of er.rows) emails.set(row.id, row.email);
    } catch {
      /* best-effort — UI still renders the user UUID if email lookup fails */
    }
  }

  return {
    rows: r.rows.map((row) => ({
      id: row.id,
      activity: row.activity,
      uploaded_at: row.uploaded_at.toISOString(),
      uploaded_by: row.uploaded_by,
      uploaded_by_email:
          row.uploaded_by ? emails.get(row.uploaded_by) ?? null : null,
      device_id: row.device_id,
      override_catalog: row.override_catalog,
      row_count: row.row_count,
      filename: row.filename,
      expires_at: row.expires_at.toISOString(),
    })),
    total,
    page,
    limit,
  };
}

export async function getCountSessionReportCsv(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<{ filename: string; csv: string } | null> {
  const r = await pool.query<{ csv_content: string; filename: string }>(
    `SELECT csv_content, filename
     FROM inventory_reports
     WHERE id = $1::uuid AND tenant_id = $2::uuid
     LIMIT 1`,
    [id, tenantId],
  );
  const row = r.rows[0];
  return row ? { filename: row.filename, csv: row.csv_content } : null;
}

export async function listCountSessionActivities(
  pool: Pool,
  tenantId: string,
): Promise<string[]> {
  const r = await pool.query<{ a: string }>(
    `SELECT DISTINCT activity AS a
     FROM inventory_reports
     WHERE tenant_id = $1::uuid
     ORDER BY 1`,
    [tenantId],
  );
  return r.rows.map((row) => row.a);
}

export async function listExternalSystemLogs(
  pool: Pool,
  tenantId: string,
  opts: { search?: string; limit?: number; dateFrom?: string; dateTo?: string },
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

  p = appendCreatedAtRange(conditions, params, p, opts);

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
