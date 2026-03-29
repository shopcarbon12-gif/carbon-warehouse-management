import type { Pool } from "pg";

export type IntegrationRow = {
  id: string;
  provider: string;
  status: string;
  location_code: string | null;
  last_ok_at: string | null;
  last_job_at: string | null;
};

export async function listIntegrations(
  pool: Pool,
  tenantId: string,
  locationId: string,
): Promise<IntegrationRow[]> {
  const r = await pool.query<IntegrationRow>(
    `SELECT
       ic.id,
       ic.provider,
       ic.status,
       l.code AS location_code,
       ic.last_ok_at::text AS last_ok_at,
       (
         SELECT max(sj.updated_at)::text
         FROM sync_jobs sj
         WHERE sj.tenant_id = ic.tenant_id
           AND (
             sj.job_type = ic.provider || '_pull'
             OR sj.job_type = ic.provider || '_push'
           )
       ) AS last_job_at
     FROM integration_connections ic
     LEFT JOIN locations l ON l.id = ic.location_id
     WHERE ic.tenant_id = $1::uuid
       AND (ic.location_id IS NULL OR ic.location_id = $2::uuid)
     ORDER BY ic.provider ASC`,
    [tenantId, locationId],
  );
  return r.rows;
}
