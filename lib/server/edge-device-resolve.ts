import type { Pool } from "pg";

export type ResolvedEdgeDevice = {
  tenantId: string;
  locationId: string;
};

/**
 * Resolve handheld `deviceId` to tenant + primary location (device row).
 * Matches `devices.name` or JSON config aliases used by the Flutter HAL.
 */
export async function resolveEdgeDevice(
  pool: Pool,
  deviceId: string,
): Promise<ResolvedEdgeDevice | null> {
  const raw = deviceId.trim();
  if (!raw) return null;

  const r = await pool.query<{ tenant_id: string; location_id: string }>(
    `SELECT d.tenant_id::text, d.location_id::text
     FROM devices d
     INNER JOIN locations l ON l.id = d.location_id AND l.tenant_id = d.tenant_id
     WHERE (
       lower(trim(d.name)) = lower(trim($1::text))
       OR lower(trim(d.config->>'deviceId')) = lower(trim($1::text))
       OR lower(trim(d.config->>'edgeDeviceId')) = lower(trim($1::text))
     )
     LIMIT 1`,
    [raw],
  );
  const row = r.rows[0];
  if (!row?.tenant_id || !row?.location_id) return null;
  return { tenantId: row.tenant_id, locationId: row.location_id };
}
