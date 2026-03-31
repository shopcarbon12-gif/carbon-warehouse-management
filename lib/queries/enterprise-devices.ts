import type { Pool } from "pg";

export type PendingHandheldRow = {
  id: string;
  name: string;
  android_id: string | null;
  is_authorized: boolean;
  location_code: string;
  location_name: string;
};

export async function listPendingHandhelds(pool: Pool, tenantId: string): Promise<PendingHandheldRow[]> {
  const r = await pool.query<{
    id: string;
    name: string;
    android_id: string | null;
    is_authorized: boolean;
    location_code: string;
    location_name: string;
  }>(
    `SELECT
       d.id::text,
       d.name,
       d.android_id,
       d.is_authorized,
       l.code AS location_code,
       l.name AS location_name
     FROM devices d
     INNER JOIN locations l ON l.id = d.location_id
     WHERE l.tenant_id = $1::uuid
       AND d.device_type = 'handheld_reader'
       AND d.is_authorized = false
     ORDER BY d.updated_at DESC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    android_id: row.android_id,
    is_authorized: row.is_authorized,
    location_code: row.location_code,
    location_name: row.location_name,
  }));
}

export async function setDeviceAuthorization(
  pool: Pool,
  tenantId: string,
  deviceId: string,
  input: { android_id?: string | null; is_authorized?: boolean },
): Promise<boolean> {
  const sets: string[] = ["updated_at = now()"];
  const params: unknown[] = [deviceId, tenantId];
  let i = 3;
  if (input.android_id !== undefined) {
    sets.push(`android_id = $${i}::varchar`);
    params.push(input.android_id?.trim() || null);
    i++;
  }
  if (input.is_authorized !== undefined) {
    sets.push(`is_authorized = $${i}::boolean`);
    params.push(input.is_authorized);
    i++;
  }
  const r = await pool.query(
    `UPDATE devices d
     SET ${sets.join(", ")}
     FROM locations l
     WHERE d.id = $1::uuid
       AND d.location_id = l.id
       AND l.tenant_id = $2::uuid`,
    params,
  );
  return (r.rowCount ?? 0) > 0;
}

export async function findDeviceByAndroidId(
  pool: Pool,
  androidId: string,
): Promise<{
  tenant_id: string;
  is_authorized: boolean;
  device_id: string;
} | null> {
  const r = await pool.query<{
    tenant_id: string;
    is_authorized: boolean;
    id: string;
  }>(
    `SELECT l.tenant_id::text, d.is_authorized, d.id::text
     FROM devices d
     INNER JOIN locations l ON l.id = d.location_id
     WHERE d.android_id = $1 AND trim(d.android_id) <> ''
     LIMIT 1`,
    [androidId.trim()],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    tenant_id: row.tenant_id,
    is_authorized: row.is_authorized,
    device_id: row.id,
  };
}
