import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { getLightspeedCredentialsForSync, credentialsLookUsableForLiveFetch } from "@/lib/server/infrastructure-settings-table";
import { tryFetchLightspeedCatalogProducts } from "@/lib/services/lightspeed-catalog-fetch";
import { computeLightspeedSyncDiff } from "@/lib/server/lightspeed-sync-diff";
import {
  isLightspeedCatalogSyncEnabled,
  LIGHTSPEED_SYNC_DISABLED_MESSAGE,
} from "@/lib/server/lightspeed-sync-flag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/inventory/sync/preview
 *
 * Step 1 of the new preview-and-confirm flow. Fetches the live Lightspeed
 * catalog, computes the diff against current WMS rows, persists everything
 * into a `sync_jobs` row keyed by a `preview_token`, and returns the diff
 * for the operator's review modal.
 *
 * Why we cache: applying the diff (step 3) MUST use the same Lightspeed
 * snapshot the operator approved. If we re-fetched at apply time we'd
 * potentially apply a different snapshot than was reviewed — which would
 * defeat the whole point of the preview UX.
 *
 * Cache lives in sync_jobs.payload as JSON: { catalog: [...], diff: {...} }.
 * Token expires implicitly after 30 minutes (apply endpoint enforces).
 *
 * Response shape:
 *   {
 *     token,
 *     summary: { lightspeed_total_variants, ..., wms_total_before, wms_total_after },
 *     gained: DiffRow[],
 *     lost: DiffRow[],
 *     unchanged_count,
 *   }
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  // WMS is the catalog source of truth — Lightspeed pull retired as a source.
  if (!isLightspeedCatalogSyncEnabled()) {
    return NextResponse.json(
      { error: LIGHTSPEED_SYNC_DISABLED_MESSAGE, code: "LS_SYNC_DISABLED" },
      { status: 409 },
    );
  }

  const creds = await getLightspeedCredentialsForSync(pool, session.tid);
  if (!credentialsLookUsableForLiveFetch(creds)) {
    return NextResponse.json(
      {
        error:
          "Lightspeed credentials incomplete. Set LS_CLIENT_ID, LS_CLIENT_SECRET, LS_REFRESH_TOKEN, and LS_ACCOUNT_ID in your environment, or populate ls_refresh_token in infrastructure_settings.",
      },
      { status: 400 },
    );
  }

  let catalog;
  try {
    catalog = await tryFetchLightspeedCatalogProducts(creds);
  } catch (e) {
    console.error("[inventory/sync/preview]", e);
    return NextResponse.json({ error: "Lightspeed fetch failed" }, { status: 502 });
  }
  if (!catalog || catalog.length === 0) {
    return NextResponse.json(
      { error: "Lightspeed returned no items. Check that the catalog isn't empty and that the credentials have read access." },
      { status: 502 },
    );
  }

  const diff = await computeLightspeedSyncDiff(pool, catalog);

  const previewToken = `pv-${randomUUID()}`;
  const idempotencyKey = `ls-preview-${randomUUID()}`;

  const ins = await pool.query<{ id: string }>(
    `INSERT INTO sync_jobs (
       tenant_id, location_id, job_type, status, idempotency_key, preview_token,
       progress_total, progress_done, progress_pct, payload
     )
     VALUES ($1::uuid, $2::uuid, 'lightspeed_catalog', 'preview', $3, $4, $5, 0, 0, $6::jsonb)
     RETURNING id::text`,
    [
      session.tid,
      session.lid,
      idempotencyKey,
      previewToken,
      // progress_total = number of writes the apply phase will perform.
      // gained + unchanged (re-upsert) + lost (archive). Keeps the bar honest.
      diff.gained.length + diff.unchanged_count + diff.lost.length,
      JSON.stringify({
        catalog,
        diff_summary: diff.summary,
        gained_ids: diff.gained.map((r) => r.ls_system_id),
        lost_ids: diff.lost.map((r) => r.ls_system_id),
        cached_at: new Date().toISOString(),
        triggered_by: session.sub,
      }),
    ],
  );

  const jobId = ins.rows[0]?.id;
  if (!jobId) {
    return NextResponse.json({ error: "Could not create preview job" }, { status: 500 });
  }

  return NextResponse.json(
    {
      token: previewToken,
      job_id: jobId,
      summary: diff.summary,
      gained: diff.gained,
      lost: diff.lost,
      unchanged_count: diff.unchanged_count,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
