import type { Pool, PoolClient } from "pg";
import type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";

/**
 * Lightspeed sync — apply phase. Reads the cached preview off `sync_jobs`,
 * upserts every matrix + variant, archives anything in WMS that wasn't in
 * the Lightspeed pull, and writes progress to sync_jobs as it goes so the
 * top-right progress bar can render an honest %.
 *
 * Reconcile semantics (the rule the operator codified):
 *   - In LS, in WMS                 → upsert (price/name/etc. updates land)
 *   - In LS, NOT in WMS             → insert
 *   - NOT in LS, in WMS             → set archived=true (NOT delete) — keeps
 *                                     items rows + history that still
 *                                     reference these custom_skus working
 *
 * Progress accounting:
 *   total = gained + unchanged_upsert + lost
 *   done is bumped after each successful row (variants only — matrix upserts
 *   are folded into their first variant for a smooth bar).
 *   pct is recomputed every batch.
 */

import {
  upsertMatrixRow as importedUpsertMatrixRow,
  upsertCustomSkuRow as importedUpsertCustomSkuRow,
  insertSyncAudit as importedInsertSyncAudit,
  pgErrorDetail as importedPgErrorDetail,
  parseAuditUserId as importedParseAuditUserId,
} from "@/lib/server/inventory-sync";

const PROGRESS_BATCH = 25;

type CachedPayload = {
  catalog: CatalogSyncMatrixPayload[];
  diff_summary?: unknown;
  gained_ids: string[];
  lost_ids: string[];
  cached_at: string;
  triggered_by: string | null;
};

async function bumpProgress(
  pool: Pool,
  jobId: string,
  done: number,
  total: number,
  message: string,
): Promise<void> {
  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  await pool.query(
    `UPDATE sync_jobs
        SET progress_done = $1,
            progress_pct = $2,
            progress_message = $3,
            updated_at = now()
      WHERE id = $4::uuid`,
    [done, pct, message, jobId],
  );
}

async function archiveMissingCustomSkus(
  client: PoolClient,
  tenantId: string,
  lostIds: string[],
): Promise<number> {
  if (lostIds.length === 0) return 0;
  const r = await client.query<{ count: string }>(
    `WITH updated AS (
       UPDATE custom_skus cs
          SET archived = TRUE
         FROM matrices m
        WHERE m.id = cs.matrix_id
          AND m.tenant_id = $1::uuid
          AND cs.ls_system_id::text = ANY($2::text[])
          AND cs.archived = FALSE
        RETURNING cs.id
     )
     SELECT COUNT(*)::text AS count FROM updated`,
    [tenantId, lostIds],
  );
  return Number.parseInt(r.rows[0]?.count ?? "0", 10) || 0;
}

export async function applyLightspeedSyncFromPreview(
  pool: Pool,
  jobId: string,
  tenantId: string,
  userSub: string | null,
): Promise<void> {
  const j = await pool.query<{ payload: CachedPayload | null; progress_total: number }>(
    `SELECT payload, progress_total FROM sync_jobs WHERE id = $1::uuid LIMIT 1`,
    [jobId],
  );
  const row = j.rows[0];
  if (!row || !row.payload || !Array.isArray(row.payload.catalog)) {
    await pool.query(
      `UPDATE sync_jobs
          SET status = 'failed',
              error = 'Cached preview missing or corrupt',
              finished_at = now(),
              updated_at = now()
        WHERE id = $1::uuid`,
      [jobId],
    );
    return;
  }

  const catalog = row.payload.catalog;
  const lostIds = row.payload.lost_ids ?? [];
  const total = row.progress_total;

  const auditUser = importedParseAuditUserId(userSub);
  let client: PoolClient | undefined;
  let done = 0;
  const warnings: string[] = [];

  try {
    client = await pool.connect();
    await client.query("BEGIN");

    await bumpProgress(pool, jobId, 0, total, "Upserting catalog rows…");

    for (const m of catalog) {
      await client.query("SAVEPOINT lsx_matrix");
      let matrixId: string | null = null;
      try {
        matrixId = await importedUpsertMatrixRow(client, m);
        await client.query("RELEASE SAVEPOINT lsx_matrix");
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT lsx_matrix");
        warnings.push(`Matrix ${m.upc ?? "(no upc)"} (${m.description}): ${importedPgErrorDetail(err)}`);
        continue;
      }
      if (!matrixId) continue;
      for (const v of m.variants) {
        await client.query("SAVEPOINT lsx_variant");
        try {
          await importedUpsertCustomSkuRow(client, matrixId, v);
          await client.query("RELEASE SAVEPOINT lsx_variant");
          done += 1;
        } catch (err) {
          await client.query("ROLLBACK TO SAVEPOINT lsx_variant");
          warnings.push(`Variant ${v.sku} (ls ${v.lsSystemId}): ${importedPgErrorDetail(err)}`);
        }
        if (done % PROGRESS_BATCH === 0) {
          await bumpProgress(pool, jobId, done, total, `Imported ${done.toLocaleString()} of ${total.toLocaleString()}…`);
        }
      }
    }

    await bumpProgress(pool, jobId, done, total, `Archiving ${lostIds.length.toLocaleString()} removed rows…`);
    const archivedCount = await archiveMissingCustomSkus(client, tenantId, lostIds);
    done += archivedCount;
    await bumpProgress(pool, jobId, done, total, "Finalising…");

    const summary = {
      records_inserted_or_updated: done - archivedCount,
      records_archived: archivedCount,
      lost_ids_seen: lostIds.length,
      warnings,
      finished_at: new Date().toISOString(),
      source: "live" as const,
    };

    await client.query(
      `UPDATE sync_jobs
          SET status = 'completed',
              error = NULL,
              progress_pct = 100,
              progress_done = progress_total,
              progress_message = 'Sync complete',
              finished_at = now(),
              updated_at = now(),
              payload = COALESCE(payload, '{}'::jsonb) || $1::jsonb
        WHERE id = $2::uuid`,
      [JSON.stringify(summary), jobId],
    );

    await importedInsertSyncAudit(client, tenantId, auditUser, jobId, "completed", summary);

    await client.query("COMMIT");
  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* ignore */
      }
    }
    const msg = importedPgErrorDetail(err);
    try {
      await pool.query(
        `UPDATE sync_jobs
            SET status = 'failed',
                error = $1,
                progress_message = 'Sync failed',
                finished_at = now(),
                updated_at = now()
          WHERE id = $2::uuid`,
        [msg.slice(0, 4000), jobId],
      );
    } catch {
      /* ignore */
    }
    console.error("[applyLightspeedSyncFromPreview]", err);
  } finally {
    client?.release();
  }
}
