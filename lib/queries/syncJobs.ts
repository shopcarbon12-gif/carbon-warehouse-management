import type { Pool } from "pg";

export type SyncJobRow = {
  id: string;
  job_type: string;
  status: string;
  idempotency_key: string;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
};

export async function enqueueSyncJob(
  pool: Pool,
  input: {
    tenantId: string;
    locationId: string | null;
    jobType: string;
    idempotencyKey: string;
    payload?: Record<string, unknown>;
  },
): Promise<{ id: string; duplicate: boolean }> {
  const payloadJson = JSON.stringify(input.payload ?? {});
  try {
    if (input.locationId) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
         VALUES ($1::uuid, $2::uuid, $3, 'queued', $4, $5::jsonb)
         RETURNING id`,
        [
          input.tenantId,
          input.locationId,
          input.jobType,
          input.idempotencyKey,
          payloadJson,
        ],
      );
      return { id: r.rows[0]!.id, duplicate: false };
    }
    const r = await pool.query<{ id: string }>(
      `INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
       VALUES ($1::uuid, NULL, $2, 'queued', $3, $4::jsonb)
       RETURNING id`,
      [input.tenantId, input.jobType, input.idempotencyKey, payloadJson],
    );
    return { id: r.rows[0]!.id, duplicate: false };
  } catch {
    const ex = await pool.query<{ id: string }>(
      `SELECT id FROM sync_jobs WHERE idempotency_key = $1 LIMIT 1`,
      [input.idempotencyKey],
    );
    return { id: ex.rows[0]?.id ?? "", duplicate: true };
  }
}

export async function listSyncJobs(
  pool: Pool,
  tenantId: string,
  limit: number,
): Promise<SyncJobRow[]> {
  const r = await pool.query<{
    id: string;
    job_type: string;
    status: string;
    idempotency_key: string;
    error: string | null;
    attempts: number;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, job_type, status, idempotency_key, error, attempts, created_at, updated_at
     FROM sync_jobs
     WHERE tenant_id = $1::uuid
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    job_type: row.job_type,
    status: row.status,
    idempotency_key: row.idempotency_key,
    error: row.error,
    attempts: row.attempts,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));
}
