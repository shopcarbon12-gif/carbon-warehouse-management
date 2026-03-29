/**
 * Carbon WMS ↔ Lightspeed Retail: OAuth helpers, catalog ingestion façade, and post-scan reconciliation.
 * Catalog upserts are implemented in `inventory-sync.ts`.
 */

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  credentialsLookUsableForLiveFetch,
  getLightspeedCredentialsForSync,
} from "@/lib/server/infrastructure-settings-table";
import { performLightspeedCatalogSync } from "@/lib/server/inventory-sync";
import { fetchLightspeedBearer, retailBaseUrl } from "@/lib/server/lightspeed-auth";
import { tryFetchLightspeedCatalogProducts } from "@/lib/services/lightspeed-catalog-fetch";

export type { CatalogSyncMatrixPayload } from "@/lib/types/catalog-sync";
export { performLightspeedCatalogSync, tryFetchLightspeedCatalogProducts };

export type LightspeedReconcilePayload = {
  tenantId: string;
  locationId: string;
  deviceId: string;
  scanContext: string;
  epcs: string[];
  metadata: Record<string, unknown>;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function insertReconcileFailureRow(
  pool: Pool,
  tenantId: string,
  locationId: string,
  error: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const key = `ls-rec-${randomUUID()}`;
  await pool.query(
    `INSERT INTO sync_jobs (
       tenant_id, location_id, job_type, status, idempotency_key, payload, error, attempts, updated_at
     )
     VALUES ($1::uuid, $2::uuid, 'lightspeed_reconcile', 'failed', $3, $4::jsonb, $5, 0, now())`,
    [tenantId, locationId, key, JSON.stringify(payload), error.slice(0, 4000)],
  );
}

/**
 * After WMS has applied the physical truth, mirror toward Lightspeed with exponential backoff.
 * Failures after all retries are written to `sync_jobs` so **Sync history** surfaces them.
 */
export async function queueLightspeedReconciliationAfterWmsChange(
  pool: Pool,
  input: LightspeedReconcilePayload,
): Promise<void> {
  const creds = await getLightspeedCredentialsForSync(pool, input.tenantId);
  if (!credentialsLookUsableForLiveFetch(creds)) return;

  const base = retailBaseUrl(creds.domainPrefix);
  const delays = [800, 1600, 3200, 6400, 12_800];
  let lastErr = "unknown";

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const bearer = await fetchLightspeedBearer(base, creds);
      if (!bearer) {
        lastErr = "no_bearer_token";
        break;
      }

      const probe = await fetch(`${base}/api/2.0/products?limit=1`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
          "User-Agent": "CarbonWMS-LightspeedSync/1.0",
        },
      });

      if (probe.status === 429 || probe.status >= 500) {
        throw new Error(`lightspeed_transient:${probe.status}`);
      }
      if (!probe.ok) {
        lastErr = `http_${probe.status}`;
        await insertReconcileFailureRow(pool, input.tenantId, input.locationId, lastErr, {
          scanContext: input.scanContext,
          epcCount: input.epcs.length,
          deviceId: input.deviceId,
          phase: "auth_probe",
        });
        return;
      }

      /* Placeholder: inventory delta APIs are account-specific. */
      return;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lastErr = msg;
      const retry = msg.includes("lightspeed_transient") || msg.includes("fetch failed");
      if (!retry || attempt >= delays.length) {
        break;
      }
      await sleep(delays[attempt] ?? 1600);
    }
  }

  await insertReconcileFailureRow(pool, input.tenantId, input.locationId, lastErr, {
    scanContext: input.scanContext,
    epcCount: input.epcs.length,
    deviceId: input.deviceId,
    exhausted: true,
  });
}
