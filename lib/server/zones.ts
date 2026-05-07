import type { Pool, PoolClient } from "pg";
import { z } from "zod";

export type ZoneRow = {
  id: string;
  tenant_id: string;
  location_id: string;
  location_code: string;
  location_name: string;
  name: string;
  description: string | null;
  device_count: number;
  reader_count: number;
  antenna_count: number;
  created_at: string;
  updated_at: string;
};

export const upsertZoneSchema = z.object({
  id: z.string().uuid().optional(),
  locationId: z.string().uuid(),
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(2000).nullable().optional(),
});

export type UpsertZoneBody = z.infer<typeof upsertZoneSchema>;

export async function listZonesForTenant(
  pool: Pool,
  tenantId: string,
  /** Active location to scope the result to. Pass null/undefined for all. */
  locationId?: string | null,
): Promise<ZoneRow[]> {
  const scoped = !!locationId;
  const r = await pool.query<ZoneRow>(
    `SELECT
       z.id::text,
       z.tenant_id::text,
       z.location_id::text,
       l.code AS location_code,
       l.name AS location_name,
       z.name,
       z.description,
       COALESCE(d_count.total, 0)::int    AS device_count,
       COALESCE(d_count.readers, 0)::int  AS reader_count,
       COALESCE(d_count.antennas, 0)::int AS antenna_count,
       z.created_at::text,
       z.updated_at::text
     FROM zones z
     INNER JOIN locations l ON l.id = z.location_id AND l.tenant_id = z.tenant_id
     LEFT JOIN LATERAL (
       SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE device_type IN ('fixed_reader', 'transaction_reader', 'door_reader')) AS readers,
         COUNT(*) FILTER (WHERE device_type = 'antenna') AS antennas
       FROM devices d
       WHERE d.zone_id = z.id
     ) d_count ON TRUE
     WHERE z.tenant_id = $1::uuid
       ${scoped ? "AND z.location_id = $2::uuid" : ""}
     ORDER BY l.code ASC, z.name ASC`,
    scoped ? [tenantId, locationId] : [tenantId],
  );
  return r.rows;
}

export async function getZoneById(
  pool: Pool,
  tenantId: string,
  id: string,
): Promise<ZoneRow | null> {
  const r = await pool.query<ZoneRow>(
    `SELECT
       z.id::text,
       z.tenant_id::text,
       z.location_id::text,
       l.code AS location_code,
       l.name AS location_name,
       z.name,
       z.description,
       0::int AS device_count,
       0::int AS reader_count,
       0::int AS antenna_count,
       z.created_at::text,
       z.updated_at::text
     FROM zones z
     INNER JOIN locations l ON l.id = z.location_id AND l.tenant_id = z.tenant_id
     WHERE z.tenant_id = $1::uuid AND z.id = $2::uuid`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

export async function upsertZone(
  client: PoolClient,
  tenantId: string,
  body: UpsertZoneBody,
): Promise<{ id: string }> {
  const locCheck = await client.query<{ id: string }>(
    `SELECT id::text FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [body.locationId, tenantId],
  );
  if (locCheck.rowCount === 0) {
    throw new Error("BAD_REQUEST:Location not found for this tenant");
  }

  if (body.id) {
    const r = await client.query<{ id: string }>(
      `UPDATE zones
         SET name = $3,
             description = $4,
             updated_at = now()
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING id::text`,
      [body.id, tenantId, body.name, body.description ?? null],
    );
    if (r.rowCount === 0) {
      throw new Error("BAD_REQUEST:Zone not found");
    }
    return { id: r.rows[0].id };
  }

  const r = await client.query<{ id: string }>(
    `INSERT INTO zones (tenant_id, location_id, name, description)
     VALUES ($1::uuid, $2::uuid, $3, $4)
     ON CONFLICT (location_id, lower(name)) DO UPDATE
       SET description = EXCLUDED.description,
           updated_at = now()
     RETURNING id::text`,
    [tenantId, body.locationId, body.name, body.description ?? null],
  );
  return { id: r.rows[0].id };
}

export async function deleteZone(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<{ deleted: boolean }> {
  const usage = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM devices WHERE zone_id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  if (Number(usage.rows[0]?.count ?? 0) > 0) {
    throw new Error("BAD_REQUEST:Zone has devices assigned; reassign or delete them first");
  }
  const r = await client.query(
    `DELETE FROM zones WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, tenantId],
  );
  return { deleted: (r.rowCount ?? 0) > 0 };
}
