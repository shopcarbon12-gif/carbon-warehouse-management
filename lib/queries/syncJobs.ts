import type { Sql } from "@/lib/db";

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
  sql: Sql,
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
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
        VALUES (
          ${input.tenantId}::uuid,
          ${input.locationId}::uuid,
          ${input.jobType},
          'queued',
          ${input.idempotencyKey},
          ${payloadJson}::jsonb
        )
        RETURNING id
      `;
      return { id: row!.id, duplicate: false };
    }
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO sync_jobs (tenant_id, location_id, job_type, status, idempotency_key, payload)
      VALUES (
        ${input.tenantId}::uuid,
        NULL,
        ${input.jobType},
        'queued',
        ${input.idempotencyKey},
        ${payloadJson}::jsonb
      )
      RETURNING id
    `;
    return { id: row!.id, duplicate: false };
  } catch {
    const [existing] = await sql<{ id: string }[]>`
      SELECT id FROM sync_jobs WHERE idempotency_key = ${input.idempotencyKey} LIMIT 1
    `;
    return { id: existing?.id ?? "", duplicate: true };
  }
}

export async function listSyncJobs(
  sql: Sql,
  tenantId: string,
  limit: number,
): Promise<SyncJobRow[]> {
  const rows = await sql<
    {
      id: string;
      job_type: string;
      status: string;
      idempotency_key: string;
      error: string | null;
      attempts: number;
      created_at: Date;
      updated_at: Date;
    }[]
  >`
    SELECT id, job_type, status, idempotency_key, error, attempts, created_at, updated_at
    FROM sync_jobs
    WHERE tenant_id = ${tenantId}::uuid
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: r.id,
    job_type: r.job_type,
    status: r.status,
    idempotency_key: r.idempotency_key,
    error: r.error,
    attempts: r.attempts,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));
}
