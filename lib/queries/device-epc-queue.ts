import type { Pool } from "pg";

export type DeviceEpcQueueRow = {
  id: string;
  device_id: string;
  epc: string;
  status: "pending" | "consumed";
  enqueued_at: string;
  consumed_at: string | null;
};

/**
 * Append EPCs to the per-device queue. Caller passes a tenant-validated device id
 * (use [resolveTenantOrError] / [listAuthorizedHandheldsForTenant] upstream).
 * Inserts skip empty/dup EPCs in the same call.
 */
export async function enqueueEpcsForDevice(
  pool: Pool,
  input: {
    tenantId: string;
    deviceId: string;
    epcs: string[];
    enqueuedBy: string | null;
  },
): Promise<{ enqueued: number }> {
  const epcs = Array.from(
    new Set(
      input.epcs
        .map((e) => e?.trim().toUpperCase())
        .filter((e): e is string => !!e && e.length > 0),
    ),
  );
  if (epcs.length === 0) return { enqueued: 0 };

  const r = await pool.query<{ inserted: string }>(
    `INSERT INTO device_epc_queue (tenant_id, device_id, epc, enqueued_by)
     SELECT $1::uuid, $2::uuid, e, $3::uuid
     FROM unnest($4::text[]) AS e
     RETURNING id::text AS inserted`,
    [input.tenantId, input.deviceId, input.enqueuedBy, epcs],
  );
  return { enqueued: r.rowCount ?? 0 };
}

/**
 * Read-only list of pending EPCs for the device. Mobile Cloud + Geiger
 * polls this and DOES NOT consume — items stay on the screen until the
 * operator either resolves them via Take an Action (which calls
 * [dismissEpcForDevice] on the resolved EPC) or slide-deletes a row
 * (same dismiss call). Pre-2026-05-29 the poller used to atomically
 * mark all returned EPCs as `consumed`, which meant a single poll
 * permanently silenced rows and an app relaunch lost everything. The
 * persistent-queue contract lets dropped tags survive app restarts and
 * shift handovers.
 */
export async function listPendingEpcsForDevice(
  pool: Pool,
  deviceId: string,
  limit = 500,
): Promise<DeviceEpcQueueRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 2000);
  const r = await pool.query<{
    id: string;
    device_id: string;
    epc: string;
    status: "pending" | "consumed";
    enqueued_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT id::text, device_id::text, epc, status, enqueued_at, consumed_at
       FROM device_epc_queue
      WHERE device_id = $1::uuid AND status = 'pending'
      ORDER BY enqueued_at ASC
      LIMIT $2`,
    [deviceId, safeLimit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    device_id: row.device_id,
    epc: row.epc,
    status: row.status,
    enqueued_at: row.enqueued_at.toISOString(),
    consumed_at: row.consumed_at ? row.consumed_at.toISOString() : null,
  }));
}

/**
 * Mark one or more EPCs as resolved for this device — either because
 * the operator slide-deleted the row, or because they completed a
 * Take an Action flow that processed the EPC. Idempotent: rows already
 * consumed (e.g. a second tab dismissed first) just no-op.
 */
export async function dismissEpcsForDevice(
  pool: Pool,
  deviceId: string,
  epcs: string[],
): Promise<{ dismissed: number }> {
  const cleaned = Array.from(
    new Set(
      epcs
        .map((e) => e?.trim().toUpperCase())
        .filter((e): e is string => !!e && e.length > 0),
    ),
  );
  if (cleaned.length === 0) return { dismissed: 0 };
  const r = await pool.query(
    `UPDATE device_epc_queue
        SET status = 'consumed', consumed_at = now()
      WHERE device_id = $1::uuid
        AND status = 'pending'
        AND epc = ANY($2::text[])`,
    [deviceId, cleaned],
  );
  return { dismissed: r.rowCount ?? 0 };
}

/** Read-only peek (no state change) — used by web for status display. */
export async function peekPendingEpcsForDevice(
  pool: Pool,
  deviceId: string,
  limit = 50,
): Promise<DeviceEpcQueueRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const r = await pool.query<{
    id: string;
    device_id: string;
    epc: string;
    status: "pending" | "consumed";
    enqueued_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT id::text, device_id::text, epc, status, enqueued_at, consumed_at
     FROM device_epc_queue
     WHERE device_id = $1::uuid AND status = 'pending'
     ORDER BY enqueued_at ASC
     LIMIT $2`,
    [deviceId, safeLimit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    device_id: row.device_id,
    epc: row.epc,
    status: row.status,
    enqueued_at: row.enqueued_at.toISOString(),
    consumed_at: row.consumed_at ? row.consumed_at.toISOString() : null,
  }));
}
