import type { Pool } from "pg";

export type DeviceUploadLogRow = {
  id: number;
  device_id: string;
  workflow_mode: string;
  created_at: string;
};

export async function insertDeviceUploadLog(
  pool: Pool,
  tenantId: string,
  input: { device_id: string; workflow_mode: string; raw_csv: string },
): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO device_upload_logs (tenant_id, device_id, workflow_mode, raw_csv)
     VALUES ($1::uuid, $2, $3, $4)
     RETURNING id::text`,
    [tenantId, input.device_id.trim(), input.workflow_mode.trim(), input.raw_csv],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("insert device_upload_logs failed");
  return Number(id);
}

export async function listDeviceUploadLogs(
  pool: Pool,
  tenantId: string,
  limit: number,
): Promise<DeviceUploadLogRow[]> {
  const r = await pool.query<{
    id: string;
    device_id: string;
    workflow_mode: string;
    created_at: Date;
  }>(
    `SELECT id::text, device_id, workflow_mode, created_at
     FROM device_upload_logs
     WHERE tenant_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, Math.min(limit, 500)],
  );
  return r.rows.map((row) => ({
    id: Number(row.id),
    device_id: row.device_id,
    workflow_mode: row.workflow_mode,
    created_at: row.created_at.toISOString(),
  }));
}

export async function getDeviceUploadLogCsv(
  pool: Pool,
  tenantId: string,
  id: number,
): Promise<{ raw_csv: string; workflow_mode: string } | null> {
  const r = await pool.query<{ raw_csv: string; workflow_mode: string }>(
    `SELECT raw_csv, workflow_mode
     FROM device_upload_logs
     WHERE id = $1 AND tenant_id = $2::uuid
     LIMIT 1`,
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}
