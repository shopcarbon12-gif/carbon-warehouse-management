import type { Pool } from "pg";

export type TenantLocationAdminRow = {
  id: string;
  code: string;
  name: string;
  lightspeed_shop_id: number | null;
  is_active: boolean;
  users: { id: string; email: string }[];
};

export async function listTenantLocationsAdmin(
  pool: Pool,
  tenantId: string,
): Promise<TenantLocationAdminRow[]> {
  const r = await pool.query<{
    id: string;
    code: string;
    name: string;
    lightspeed_shop_id: string | null;
    is_active: boolean;
    users: unknown;
  }>(
    `SELECT
       l.id::text,
       l.code,
       l.name,
       l.lightspeed_shop_id::text,
       l.is_active,
       COALESCE(
         json_agg(
           DISTINCT jsonb_build_object(
             'id', u.id::text,
             'email', u.email
           )
         ) FILTER (WHERE u.id IS NOT NULL),
         '[]'::json
       ) AS users
     FROM locations l
     LEFT JOIN user_locations ul ON ul.location_id = l.id
     LEFT JOIN users u ON u.id = ul.user_id
     WHERE l.tenant_id = $1::uuid
     GROUP BY l.id, l.code, l.name, l.lightspeed_shop_id, l.is_active
     ORDER BY l.code ASC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    lightspeed_shop_id:
      row.lightspeed_shop_id != null && row.lightspeed_shop_id !== ""
        ? Number(row.lightspeed_shop_id)
        : null,
    is_active: row.is_active,
    users: Array.isArray(row.users) ? (row.users as { id: string; email: string }[]) : [],
  }));
}

export async function insertTenantLocation(
  pool: Pool,
  tenantId: string,
  input: {
    code: string;
    name: string;
    lightspeed_shop_id: number | null;
    is_active: boolean;
    userIds: string[];
  },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: string }>(
      `INSERT INTO locations (tenant_id, code, name, lightspeed_shop_id, is_active)
       VALUES ($1::uuid, $2, $3, $4::int, $5::boolean)
       RETURNING id::text`,
      [
        tenantId,
        input.code.trim(),
        input.name.trim(),
        input.lightspeed_shop_id,
        input.is_active,
      ],
    );
    const lid = ins.rows[0]?.id;
    if (!lid) throw new Error("location insert failed");

    for (const uid of input.userIds) {
      const uok = await client.query(
        `SELECT 1 FROM memberships WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
        [uid, tenantId],
      );
      if (uok.rows[0]) {
        await client.query(
          `INSERT INTO user_locations (user_id, location_id) VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [uid, lid],
        );
      }
    }

    await client.query("COMMIT");
    return lid;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function updateTenantLocation(
  pool: Pool,
  tenantId: string,
  locationId: string,
  input: {
    code: string;
    name: string;
    lightspeed_shop_id: number | null;
    is_active: boolean;
    userIds: string[];
  },
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = await client.query(
      `UPDATE locations
       SET code = $3,
           name = $4,
           lightspeed_shop_id = $5::int,
           is_active = $6::boolean
       WHERE id = $1::uuid AND tenant_id = $2::uuid
       RETURNING id`,
      [
        locationId,
        tenantId,
        input.code.trim(),
        input.name.trim(),
        input.lightspeed_shop_id,
        input.is_active,
      ],
    );
    if ((u.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(`DELETE FROM user_locations WHERE location_id = $1::uuid`, [locationId]);
    for (const uid of input.userIds) {
      const uok = await client.query(
        `SELECT 1 FROM memberships WHERE user_id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
        [uid, tenantId],
      );
      if (uok.rows[0]) {
        await client.query(
          `INSERT INTO user_locations (user_id, location_id) VALUES ($1::uuid, $2::uuid)
           ON CONFLICT DO NOTHING`,
          [uid, locationId],
        );
      }
    }

    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteTenantLocation(pool: Pool, tenantId: string, locationId: string): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [locationId, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
