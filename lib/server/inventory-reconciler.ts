import type { Pool, PoolClient } from "pg";
import { publishEdgeScanEvent } from "@/lib/server/edge-scan-hub";
import { queueLightspeedReconciliationAfterWmsChange } from "@/lib/server/lightspeed-sync";
import {
  findTransferBlockedEpc,
  resolveEpcVisibilityForTenant,
} from "@/lib/server/status-label-enforcement";

export type ReconcilerBatchInput = {
  tenantId: string;
  locationId: string;
  deviceId: string;
  scanContext: string;
  epcs: string[];
  metadata: Record<string, unknown>;
  timestamp?: string;
};

function asUuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return /^[0-9a-f-]{36}$/i.test(t) ? t : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

async function resolveDestinationBinId(
  client: PoolClient,
  tenantId: string,
  deviceLocationId: string,
  metadata: Record<string, unknown>,
): Promise<string | null> {
  const direct =
    asUuid(metadata.destinationBinId) ??
    asUuid(metadata.destination_bin_id) ??
    asUuid((metadata.destination as Record<string, unknown> | undefined)?.binId);
  if (direct) {
    const ok = await client.query<{ id: string }>(
      `SELECT b.id::text
       FROM bins b
       INNER JOIN locations l ON l.id = b.location_id AND l.tenant_id = $2::uuid
       WHERE b.id = $1::uuid AND b.archived_at IS NULL
       LIMIT 1`,
      [direct, tenantId],
    );
    return ok.rows[0]?.id ?? null;
  }

  const code =
    asNonEmptyString(metadata.destinationLocation) ??
    asNonEmptyString(metadata.destination_location) ??
    asNonEmptyString(metadata.destinationBinCode);
  if (!code) return null;

  const r = await client.query<{ id: string }>(
    `SELECT b.id::text
     FROM bins b
     INNER JOIN locations l ON l.id = b.location_id AND l.tenant_id = $3::uuid
     WHERE b.location_id = $1::uuid
       AND lower(trim(b.code)) = lower(trim($2::text))
       AND b.archived_at IS NULL
     LIMIT 1`,
    [deviceLocationId, code, tenantId],
  );
  return r.rows[0]?.id ?? null;
}

function mapStatusMetadata(metadata: Record<string, unknown>): string | null {
  const raw =
    asNonEmptyString(metadata.statusBucket) ??
    asNonEmptyString(metadata.status) ??
    asNonEmptyString(metadata.status_bucket);
  if (!raw) return null;
  const u = raw.toUpperCase().replace(/-/g, "_").replace(/\s+/g, "_");
  const m: Record<string, string> = {
    MISSING: "UNKNOWN",
    UNKNOWN: "UNKNOWN",
    DAMAGED: "damaged",
    IN_STOCK: "in-stock",
    INSTOCK: "in-stock",
    LIVE: "in-stock",
    SOLD: "sold",
    RETURN: "return",
    STOLEN: "stolen",
    TAG_KILLED: "tag_killed",
    PENDING_VISIBILITY: "pending_visibility",
    IN_TRANSIT: "in-transit",
    PENDING_TRANSACTION: "pending_transaction",
  };
  return m[u] ?? null;
}

/**
 * Apply WMS updates in a **single transaction**, then SSE + async Lightspeed reconciliation.
 */
export async function reconcileInventoryFromEdge(
  pool: Pool,
  input: ReconcilerBatchInput,
): Promise<{ rowsAffected: number; error?: string }> {
  const epcs = [...new Set(input.epcs.map((e) => e.trim().toUpperCase()))].filter(
    (e) => /^[0-9A-F]{24}$/.test(e),
  );
  if (epcs.length === 0) {
    return { rowsAffected: 0, error: "no_valid_epcs" };
  }

  const ctx = input.scanContext.trim().toUpperCase();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    let rowsAffected = 0;

    let workEpcs = epcs;
    if (ctx === "TRANSFER" || ctx === "STATUS_CHANGE") {
      const vis = await resolveEpcVisibilityForTenant(client, input.tenantId, epcs);
      workEpcs = vis.filter((v) => v.visible).map((v) => v.epc);
    }

    if (ctx === "TRANSFER") {
      const blocked = await findTransferBlockedEpc(client, input.tenantId, workEpcs);
      if (blocked) {
        await client.query("ROLLBACK");
        return {
          rowsAffected: 0,
          error: `BAD_REQUEST:Item ${blocked} cannot be processed in its current status.`,
        };
      }

      const destBinId = await resolveDestinationBinId(
        client,
        input.tenantId,
        input.locationId,
        input.metadata,
      );
      if (!destBinId) {
        await client.query("ROLLBACK");
        return { rowsAffected: 0, error: "destination_bin_unresolved" };
      }

      const u = await client.query(
        `UPDATE items i
         SET bin_id = $1::uuid
         FROM locations loc
         WHERE i.epc = ANY($2::text[])
           AND i.location_id = $3::uuid
           AND loc.id = i.location_id
           AND loc.tenant_id = $4::uuid`,
        [destBinId, workEpcs, input.locationId, input.tenantId],
      );
      rowsAffected = u.rowCount ?? 0;
    } else if (ctx === "STATUS_CHANGE") {
      const status = mapStatusMetadata(input.metadata);
      if (!status) {
        await client.query("ROLLBACK");
        return { rowsAffected: 0, error: "status_unresolved" };
      }
      const u = await client.query(
        `UPDATE items i
         SET status = $1::varchar
         FROM locations loc
         WHERE i.epc = ANY($2::text[])
           AND i.location_id = $3::uuid
           AND loc.id = i.location_id
           AND loc.tenant_id = $4::uuid`,
        [status, workEpcs, input.locationId, input.tenantId],
      );
      rowsAffected = u.rowCount ?? 0;
    } else if (ctx === "EXCEPTION_ALARM") {
      const ins = await client.query(
        `INSERT INTO rfid_alarms (
           tenant_id, location_id, device_id, scan_context, epcs, metadata
         )
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          input.tenantId,
          input.locationId,
          input.deviceId.slice(0, 256),
          "EXCEPTION_ALARM",
          JSON.stringify(epcs),
          JSON.stringify(input.metadata ?? {}),
        ],
      );
      rowsAffected = ins.rowCount ?? 1;
    } else {
      rowsAffected = 0;
    }

    await client.query("COMMIT");

    const epcsForEvent = ctx === "TRANSFER" || ctx === "STATUS_CHANGE" ? workEpcs : epcs;

    publishEdgeScanEvent(input.tenantId, input.locationId, {
      deviceId: input.deviceId,
      locationId: input.locationId,
      scanContext: input.scanContext,
      epcs: epcsForEvent,
      timestamp: input.timestamp,
      rowsAffected,
    });

    if (ctx === "TRANSFER" || ctx === "STATUS_CHANGE") {
      void queueLightspeedReconciliationAfterWmsChange(pool, {
        tenantId: input.tenantId,
        locationId: input.locationId,
        deviceId: input.deviceId,
        scanContext: ctx,
        epcs: epcsForEvent,
        metadata: input.metadata,
      });
    }

    return { rowsAffected };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[inventory-reconciler]", msg);
    return { rowsAffected: 0, error: msg };
  } finally {
    client.release();
  }
}
