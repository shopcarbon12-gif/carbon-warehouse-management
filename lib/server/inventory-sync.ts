import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";
import { simulateSyncPayload } from "@/lib/server/lightspeed-catalog-mapper";
import {
  credentialsLookUsableForLiveFetch,
  getLightspeedCredentialsForSync,
} from "@/lib/server/infrastructure-settings-table";
import { tryFetchLightspeedCatalogProducts } from "@/lib/services/lightspeed-catalog-fetch";

export type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";

export type SyncJobLogRow = {
  id: string;
  status: string;
  job_type: string;
  error: string | null;
  payload: unknown;
  created_at: string;
  updated_at: string;
};

export type SyncStatusSummary = {
  last_success_at: string | null;
  total_catalog_skus: number;
};

export async function getSyncStatusSummary(
  pool: Pool,
  tenantId: string,
): Promise<SyncStatusSummary> {
  const [last, cnt] = await Promise.all([
    pool.query<{ t: Date | null }>(
      `SELECT MAX(updated_at) AS t
       FROM sync_jobs
       WHERE tenant_id = $1::uuid
         AND job_type = 'lightspeed_catalog'
         AND status = 'completed'`,
      [tenantId],
    ),
    pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM custom_skus`),
  ]);

  const t = last.rows[0]?.t;
  return {
    last_success_at: t ? t.toISOString() : null,
    total_catalog_skus: Number(cnt.rows[0]?.c ?? 0),
  };
}

export async function listSyncJobLogs(
  pool: Pool,
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ rows: SyncJobLogRow[]; total: number }> {
  const safeLimit = Math.min(100, Math.max(1, limit));
  const offset = Math.max(0, (page - 1) * safeLimit);

  const countR = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM sync_jobs
     WHERE tenant_id = $1::uuid
       AND job_type IN ('lightspeed_catalog', 'lightspeed_reconcile')`,
    [tenantId],
  );
  const total = Number(countR.rows[0]?.c ?? 0);

  const r = await pool.query<{
    id: string;
    status: string;
    job_type: string;
    error: string | null;
    payload: unknown;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id::text, status, job_type, error, payload, created_at, updated_at
     FROM sync_jobs
     WHERE tenant_id = $1::uuid
       AND job_type IN ('lightspeed_catalog', 'lightspeed_reconcile')
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, safeLimit, offset],
  );

  return {
    rows: r.rows.map((row) => ({
      id: row.id,
      status: row.status,
      job_type: row.job_type,
      error: row.error,
      payload: row.payload,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    })),
    total,
  };
}

export async function enqueueLightspeedCatalogSync(
  pool: Pool,
  tenantId: string,
  locationId: string,
  userId: string,
): Promise<{ job_id: string }> {
  const idempotency_key = `ls-cat-${randomUUID()}`;
  const ins = await pool.query<{ id: string }>(
    `INSERT INTO sync_jobs (
       tenant_id, location_id, job_type, status, idempotency_key, payload
     )
     VALUES ($1::uuid, $2::uuid, 'lightspeed_catalog', 'queued', $3, $4::jsonb)
     RETURNING id::text`,
    [
      tenantId,
      locationId,
      idempotency_key,
      JSON.stringify({ trigger: "manual", user_id: userId, enqueued_at: new Date().toISOString() }),
    ],
  );
  const id = ins.rows[0]?.id;
  if (!id) throw new Error("enqueue failed");
  return { job_id: id };
}

function parseAuditUserId(userSub: string | null): string | null {
  if (!userSub?.trim()) return null;
  const t = userSub.trim();
  return /^[0-9a-f-]{36}$/i.test(t) ? t : null;
}

async function insertSyncAudit(
  client: PoolClient,
  tenantId: string,
  userId: string | null,
  jobId: string,
  status: "completed" | "failed",
  meta: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
    [
      tenantId,
      userId,
      "lightspeed_catalog_sync",
      "sync_job",
      JSON.stringify({
        job_id: jobId,
        status,
        ...meta,
      }),
    ],
  );
}

async function upsertMatrixRow(
  client: PoolClient,
  row: CatalogSyncMatrixPayload,
): Promise<string> {
  const ins = await client.query<{ id: string }>(
    `INSERT INTO matrices (upc, description, brand, category, vendor, ls_system_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (upc) DO UPDATE SET
       description = EXCLUDED.description,
       brand = COALESCE(EXCLUDED.brand, matrices.brand),
       category = COALESCE(EXCLUDED.category, matrices.category),
       vendor = COALESCE(EXCLUDED.vendor, matrices.vendor),
       ls_system_id = COALESCE(EXCLUDED.ls_system_id, matrices.ls_system_id)
     RETURNING id::text`,
    [
      row.upc.trim(),
      row.description.trim(),
      row.brand?.trim() || null,
      row.category?.trim() || null,
      row.vendor?.trim() || null,
      row.matrixLsSystemId,
    ],
  );
  const id = ins.rows[0]?.id;
  if (!id) throw new Error("matrix upsert returned no id");
  return id;
}

async function upsertCustomSkuRow(
  client: PoolClient,
  matrixId: string,
  v: CatalogSyncMatrixPayload["variants"][number],
): Promise<void> {
  const price =
    v.retailPrice != null && v.retailPrice.trim() !== ""
      ? Number.parseFloat(v.retailPrice)
      : null;
  const priceParam = price != null && Number.isFinite(price) ? String(price) : null;

  await client.query(
    `INSERT INTO custom_skus (matrix_id, sku, ls_system_id, color_code, size, retail_price, upc)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::numeric, $7)
     ON CONFLICT (ls_system_id) DO UPDATE SET
       matrix_id = EXCLUDED.matrix_id,
       sku = EXCLUDED.sku,
       color_code = EXCLUDED.color_code,
       size = EXCLUDED.size,
       retail_price = COALESCE(EXCLUDED.retail_price, custom_skus.retail_price),
       upc = COALESCE(EXCLUDED.upc, custom_skus.upc)`,
    [
      matrixId,
      v.sku.trim(),
      v.lsSystemId,
      v.color?.trim() || null,
      v.size?.trim() || null,
      priceParam,
      v.upc?.trim() || null,
    ],
  );
}

function pgErrorDetail(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const code = String((err as { code?: string }).code ?? "");
    const msg = String((err as { message?: string }).message ?? err);
    return code ? `${code}: ${msg}` : msg;
  }
  return err instanceof Error ? err.message : String(err);
}

export type CatalogSyncResult =
  | {
      ok: true;
      records_updated: number;
      source: "live" | "simulated";
      warnings: string[];
      job_id: string;
    }
  | { ok: false; error: string; job_id: string };

/**
 * Runs catalog ingestion: credentials → live fetch or simulated payload → transactional upserts.
 * Updates `sync_jobs` to terminal `completed` or `failed` and appends `audit_log`.
 */
export async function performLightspeedCatalogSync(
  pool: Pool,
  jobId: string,
  tenantId: string,
  userSub: string | null,
): Promise<CatalogSyncResult> {
  const auditUser = parseAuditUserId(userSub);
  let client: PoolClient | undefined;

  try {
    const creds = await getLightspeedCredentialsForSync(pool, tenantId);

    let source: "live" | "simulated" = "simulated";
    let matrices: CatalogSyncMatrixPayload[] = simulateSyncPayload();

    if (credentialsLookUsableForLiveFetch(creds)) {
      try {
        const live = await tryFetchLightspeedCatalogProducts(creds);
        if (live && live.length > 0) {
          matrices = live;
          source = "live";
        }
      } catch {
        /* fall through to simulated */
      }
    }

    client = await pool.connect();
    await client.query("BEGIN");

    const warnings: string[] = [];
    let records_updated = 0;

    for (const m of matrices) {
      try {
        const matrixId = await upsertMatrixRow(client, m);
        for (const v of m.variants) {
          try {
            await upsertCustomSkuRow(client, matrixId, v);
            records_updated += 1;
          } catch (err) {
            warnings.push(`Variant ${v.sku} (ls ${v.lsSystemId}): ${pgErrorDetail(err)}`);
          }
        }
      } catch (err) {
        warnings.push(`Matrix ${m.upc} (${m.description}): ${pgErrorDetail(err)}`);
      }
    }

    const payloadExtra = {
      records_updated,
      source,
      warnings,
      finished_at: new Date().toISOString(),
    };

    await client.query(
      `UPDATE sync_jobs
       SET
         status = 'completed',
         error = NULL,
         updated_at = now(),
         payload = COALESCE(payload, '{}'::jsonb) || $1::jsonb
       WHERE id = $2::uuid`,
      [JSON.stringify(payloadExtra), jobId],
    );

    await insertSyncAudit(client, tenantId, auditUser, jobId, "completed", payloadExtra);

    await client.query("COMMIT");

    return { ok: true, records_updated, source, warnings, job_id: jobId };
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
    }

    const msg = pgErrorDetail(err);
    const payloadExtra = {
      records_updated: 0,
      source: "simulated" as const,
      warnings: [] as string[],
      fatal: true,
      finished_at: new Date().toISOString(),
    };

    try {
      await pool.query(
        `UPDATE sync_jobs
         SET
           status = 'failed',
           error = $1,
           updated_at = now(),
           payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
         WHERE id = $3::uuid`,
        [msg.slice(0, 4000), JSON.stringify(payloadExtra), jobId],
      );
      await pool.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)`,
        [
          tenantId,
          auditUser,
          "lightspeed_catalog_sync",
          "sync_job",
          JSON.stringify({
            job_id: jobId,
            status: "failed",
            ...payloadExtra,
            error: msg,
          }),
        ],
      );
    } catch (logErr) {
      console.error("[performLightspeedCatalogSync] failed to log failure", logErr);
    }

    return { ok: false, error: msg, job_id: jobId };
  } finally {
    client?.release();
  }
}

/** Worker entry: resolves tenant from job row then runs `performLightspeedCatalogSync`. */
export async function executeLightspeedCatalogJob(pool: Pool, jobId: string): Promise<void> {
  const j = await pool.query<{ tenant_id: string; payload: unknown }>(
    `SELECT tenant_id, payload FROM sync_jobs WHERE id = $1::uuid LIMIT 1`,
    [jobId],
  );
  const row = j.rows[0];
  if (!row) return;

  let userSub: string | null = null;
  const p = row.payload;
  if (p && typeof p === "object" && !Array.isArray(p) && "user_id" in p) {
    userSub = String((p as Record<string, unknown>).user_id ?? "") || null;
  }

  const r = await performLightspeedCatalogSync(pool, jobId, row.tenant_id, userSub);
  if (!r.ok) {
    /* Job row already marked failed inside `performLightspeedCatalogSync`. */
    return;
  }
}
