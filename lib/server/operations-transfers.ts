import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { findTransferBlockedEpc } from "@/lib/server/status-label-enforcement";
import { ingestEpcs } from "@/lib/server/epc-ingress";

function normalizeEpc(s: string): string {
  return s.replace(/\s/g, "").toUpperCase();
}

const epcHex24 = z
  .string()
  .transform((s) => normalizeEpc(s))
  .refine((s) => /^[0-9A-F]{24}$/.test(s), "Invalid 24-char hex EPC");

export const transferCommitSchema = z
  .object({
    sourceLocationId: z.string().uuid(),
    destinationLocationId: z.string().uuid(),
    epcs: z
      .array(epcHex24)
      .max(500)
      .transform((a) => [...new Set(a)])
      .default([]),
    manualLines: z
      .array(
        z.object({
          customSkuId: z.string().uuid(),
          qty: z.number().int().positive().max(10000),
        }),
      )
      .max(500)
      .default([]),
    notes: z.string().max(1024).optional(),
  })
  .refine(
    (b) => b.epcs.length > 0 || b.manualLines.length > 0,
    { message: "At least one RFID or manual line is required" },
  )
  .refine(
    (b) => b.sourceLocationId !== b.destinationLocationId,
    { message: "Source and destination must differ" },
  );

export type TransferCommitBody = z.infer<typeof transferCommitSchema>;

export type SessionPayload = {
  sub: string;
  tid: string;
  lid: string;
};

export type TransferLookupRow = {
  epc: string;
  sku: string;
  location_id: string;
  location_code: string;
  bin_id: string | null;
  bin_code: string | null;
  status: string;
  /** Catalog-enriched fields. Match mobile count-screen `_GroupedRow`. */
  name: string | null;
  color: string | null;
  size: string | null;
  upc: string | null;
  asset_id: string | null;
  vendor: string | null;
  retail_price: string | null;
  custom_sku_id: string;
  /** custom_skus.ls_system_id — surfaced as "System ID" in UI, mirroring catalog. */
  sku_ls_system_id: string | null;
};

/**
 * For any EPCs that aren't yet in `items`, run them through the unified
 * ingress (decode + catalog lookup + insert). Picks an arbitrary tenant
 * location to associate with the new items — the operator's commit will
 * relocate them to the actual destination, so the initial location is
 * just bookkeeping.
 *
 * Quietly returns when there are no missing EPCs or when the tenant has
 * no locations (in which case ingress would fail anyway).
 */
async function maybeIngestNewTransferEpcs(
  pool: Pool,
  tenantId: string,
  epcs: string[],
): Promise<void> {
  if (epcs.length === 0) return;

  const existing = await pool.query<{ epc: string }>(
    `SELECT i.epc
       FROM items i
       INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
       WHERE i.epc = ANY($2::text[])`,
    [tenantId, epcs],
  );
  const existingSet = new Set(existing.rows.map((r) => r.epc));
  const missing = epcs.filter((e) => !existingSet.has(e));
  if (missing.length === 0) return;

  // Pick any tenant location for the initial insert. The operator's commit
  // will move these items to the actual destination location/bin.
  const loc = await pool.query<{ id: string }>(
    `SELECT id::text FROM locations WHERE tenant_id = $1::uuid ORDER BY code LIMIT 1`,
    [tenantId],
  );
  if (loc.rowCount === 0 || !loc.rows[0]) return;
  const stagingLocationId = loc.rows[0].id;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ingestEpcs(client, missing.map((epc) => ({
      tenantId,
      epc,
      source: "transfer" as const,
      sourceDeviceLabel: null,
      locationId: stagingLocationId,
      receivedAt: new Date(),
    })));
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    // Don't fail the whole lookup if ingress fails — log and move on.
    console.error("[transfers/lookup] ingress failed", e);
  } finally {
    client.release();
  }
}

export async function lookupTransferEpcs(
  pool: Pool,
  tenantId: string,
  epcs: string[],
): Promise<TransferLookupRow[]> {
  const norm = [...new Set(epcs.map(normalizeEpc))].filter((e) =>
    /^[0-9A-F]{24}$/.test(e),
  );
  if (norm.length === 0) return [];

  // Unified ingress: any EPC not already in `items` is decoded against the
  // tenant's EPC formula and matched to a custom_sku via ls_system_id.
  // Matched → status='in-stock' (LIVE). Unmatched/undecodable → status='tag_killed'
  // (which is not visible to scanner — gets filtered out of the response below).
  // This is what makes the Transfers page able to "auto-flip a previously-unknown
  // EPC to LIVE" the moment a matching SKU exists in the catalog.
  await maybeIngestNewTransferEpcs(pool, tenantId, norm);

  const r = await pool.query<{
    epc: string;
    sku: string;
    location_id: string;
    location_code: string;
    bin_id: string | null;
    bin_code: string | null;
    status: string;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    asset_id: string | null;
    vendor: string | null;
    retail_price: string | null;
    custom_sku_id: string;
    sku_ls_system_id: string | null;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       i.location_id::text,
       l.code AS location_code,
       i.bin_id::text AS bin_id,
       b.code AS bin_code,
       i.status,
       m.description AS name,
       cs.color_code AS color,
       cs.size,
       COALESCE(cs.upc, m.upc) AS upc,
       cs.asset_id,
       m.vendor,
       cs.retail_price::text AS retail_price,
       cs.id::text AS custom_sku_id,
       cs.ls_system_id::text AS sku_ls_system_id
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, norm],
  );

  return r.rows.map((row) => ({
    epc: normalizeEpc(row.epc),
    sku: row.sku,
    location_id: row.location_id,
    location_code: row.location_code,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
    status: row.status,
    name: row.name,
    color: row.color,
    size: row.size,
    upc: row.upc,
    asset_id: row.asset_id,
    vendor: row.vendor,
    retail_price: row.retail_price,
    custom_sku_id: row.custom_sku_id,
    sku_ls_system_id: row.sku_ls_system_id,
  }));
}

export async function listSimTransferEpcs(
  pool: Pool,
  tenantId: string,
  locationId: string,
  limit: number,
): Promise<TransferLookupRow[]> {
  const r = await pool.query<{
    epc: string;
    sku: string;
    location_id: string;
    location_code: string;
    bin_id: string | null;
    bin_code: string | null;
    status: string;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    asset_id: string | null;
    vendor: string | null;
    retail_price: string | null;
    custom_sku_id: string;
    sku_ls_system_id: string | null;
  }>(
    `SELECT
       i.epc,
       cs.sku,
       i.location_id::text,
       l.code AS location_code,
       i.bin_id::text AS bin_id,
       b.code AS bin_code,
       i.status,
       m.description AS name,
       cs.color_code AS color,
       cs.size,
       COALESCE(cs.upc, m.upc) AS upc,
       cs.asset_id,
       m.vendor,
       cs.retail_price::text AS retail_price,
       cs.id::text AS custom_sku_id,
       cs.ls_system_id::text AS sku_ls_system_id
     FROM items i
     INNER JOIN locations l ON l.id = i.location_id AND l.tenant_id = $1::uuid
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.location_id = $2::uuid
       AND i.status = 'in-stock'
     ORDER BY random()
     LIMIT $3`,
    [tenantId, locationId, limit],
  );
  return r.rows.map((row) => ({
    epc: normalizeEpc(row.epc),
    sku: row.sku,
    location_id: row.location_id,
    location_code: row.location_code,
    bin_id: row.bin_id,
    bin_code: row.bin_code,
    status: row.status,
    name: row.name,
    color: row.color,
    size: row.size,
    upc: row.upc,
    asset_id: row.asset_id,
    vendor: row.vendor,
    retail_price: row.retail_price,
    custom_sku_id: row.custom_sku_id,
    sku_ls_system_id: row.sku_ls_system_id,
  }));
}

export type TransferCommitResult = {
  transferId: string;
  rfidCount: number;
  manualCount: number;
  auditId: string;
};

/**
 * Transfer Out commit. Creates a transfer_records row, flips RFID items to
 * status='in-transit' (location → destination, bin → NULL, transfer_id → new),
 * and writes inventory_adjustments for any manual lines (source side settles
 * immediately; destination side waits for the receive step).
 */
export async function commitTransfer(
  client: PoolClient,
  session: SessionPayload,
  body: TransferCommitBody,
): Promise<TransferCommitResult> {
  const { sourceLocationId, destinationLocationId, epcs, manualLines, notes } = body;

  const locs = await client.query<{ id: string; code: string; name: string }>(
    `SELECT id::text, code, name FROM locations
     WHERE id = ANY($1::uuid[]) AND tenant_id = $2::uuid`,
    [[sourceLocationId, destinationLocationId], session.tid],
  );
  const src = locs.rows.find((r) => r.id === sourceLocationId);
  const dst = locs.rows.find((r) => r.id === destinationLocationId);
  if (!src) throw new Error("BAD_REQUEST:Source location not found");
  if (!dst) throw new Error("BAD_REQUEST:Destination location not found");

  if (epcs.length > 0) {
    const blocked = await findTransferBlockedEpc(client, session.tid, epcs);
    if (blocked) {
      throw new Error(`BAD_REQUEST:Item ${blocked} cannot be processed in its current status.`);
    }
  }

  // Validate every EPC exists at the declared source location and is in-stock.
  let rfidLocationOk = true;
  let badEpcSample = "";
  if (epcs.length > 0) {
    const rows = await client.query<{ epc: string; location_id: string; status: string }>(
      `SELECT i.epc, i.location_id::text, i.status
       FROM items i
       INNER JOIN locations loc ON loc.id = i.location_id AND loc.tenant_id = $1::uuid
       WHERE i.epc = ANY($2::text[])`,
      [session.tid, epcs],
    );
    if (rows.rows.length !== epcs.length) {
      throw new Error("BAD_REQUEST:One or more EPCs were not found in this tenant");
    }
    for (const r of rows.rows) {
      if (r.location_id !== sourceLocationId || r.status !== "in-stock") {
        rfidLocationOk = false;
        badEpcSample = r.epc;
        break;
      }
    }
    if (!rfidLocationOk) {
      throw new Error(
        `BAD_REQUEST:EPC ${badEpcSample} is not in-stock at the chosen source location.`,
      );
    }
  }

  // Validate manual lines reference real custom_skus.
  if (manualLines.length > 0) {
    const skuIds = manualLines.map((l) => l.customSkuId);
    const skuCheck = await client.query<{ id: string }>(
      `SELECT id::text FROM custom_skus WHERE id = ANY($1::uuid[])`,
      [skuIds],
    );
    if (skuCheck.rowCount !== new Set(skuIds).size) {
      throw new Error("BAD_REQUEST:One or more manual SKUs are unknown");
    }
  }

  // 1. Create the transfer record.
  const trIns = await client.query<{ id: string }>(
    `INSERT INTO transfer_records
       (tenant_id, source_location_id, destination_location_id, state,
        rfid_count, manual_count, created_by, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'in-transit', $4, $5, $6::uuid, $7)
     RETURNING id::text`,
    [
      session.tid,
      sourceLocationId,
      destinationLocationId,
      epcs.length,
      manualLines.reduce((acc, l) => acc + l.qty, 0),
      session.sub,
      notes ?? null,
    ],
  );
  const transferId = trIns.rows[0]!.id;

  // 2. Flip RFID items to in-transit, attach to this transfer.
  let movedRfid = 0;
  if (epcs.length > 0) {
    const upd = await client.query(
      `UPDATE items
       SET location_id = $1::uuid,
           bin_id = NULL,
           status = 'in-transit',
           transfer_id = $2::uuid
       WHERE epc = ANY($3::text[])`,
      [destinationLocationId, transferId, epcs],
    );
    movedRfid = upd.rowCount ?? 0;
  }

  // 3. Write manual adjustments (source settled now, destination pending receive).
  let manualUnits = 0;
  for (const line of manualLines) {
    manualUnits += line.qty;
    await client.query(
      `INSERT INTO inventory_adjustments
         (tenant_id, custom_sku_id, location_id, transfer_id,
          side, state, qty_delta, reason, created_by, settled_at)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
          'source', 'settled', $5, 'manual_transfer', $6::uuid, now())`,
      [session.tid, line.customSkuId, sourceLocationId, transferId, -line.qty, session.sub],
    );
    await client.query(
      `INSERT INTO inventory_adjustments
         (tenant_id, custom_sku_id, location_id, transfer_id,
          side, state, qty_delta, reason, created_by)
       VALUES
         ($1::uuid, $2::uuid, $3::uuid, $4::uuid,
          'destination', 'in-transit', $5, 'manual_transfer', $6::uuid)`,
      [session.tid, line.customSkuId, destinationLocationId, transferId, line.qty, session.sub],
    );
  }

  // 4. Audit row mirroring legacy `rfid_transfer` action so downstream reports
  // (Activity history, Asset movements) keep working.
  const audit = await client.query<{ id: string }>(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'rfid_transfer', 'items', $3::jsonb)
     RETURNING id::text`,
    [
      session.tid,
      session.sub,
      JSON.stringify({
        transfer_id: transferId,
        source_location: { id: src.id, code: src.code, name: src.name },
        destination_location: { id: dst.id, code: dst.code, name: dst.name },
        epcs,
        manual_lines: manualLines,
        rfid_count: movedRfid,
        manual_units: manualUnits,
        state: "in-transit",
      }),
    ],
  );

  return {
    transferId,
    rfidCount: movedRfid,
    manualCount: manualUnits,
    auditId: audit.rows[0]?.id ?? "",
  };
}

/* ===========================================================================
 *  Pending transfers list (Transfer In page)
 * ========================================================================= */

export type PendingTransferRow = {
  id: string;
  source_location_id: string;
  source_location_code: string;
  source_location_name: string;
  destination_location_id: string;
  destination_location_code: string;
  destination_location_name: string;
  state: string;
  rfid_count: number;
  manual_count: number;
  rfid_pending: number;
  manual_pending: number;
  created_at: string;
  created_by_name: string | null;
  notes: string | null;
};

export async function listPendingTransfersForDestination(
  pool: Pool,
  tenantId: string,
  destinationLocationId: string,
): Promise<PendingTransferRow[]> {
  const r = await pool.query<{
    id: string;
    source_location_id: string;
    source_location_code: string;
    source_location_name: string;
    destination_location_id: string;
    destination_location_code: string;
    destination_location_name: string;
    state: string;
    rfid_count: number;
    manual_count: number;
    rfid_pending: number;
    manual_pending: number;
    created_at: string;
    created_by_name: string | null;
    notes: string | null;
  }>(
    `SELECT
       tr.id::text,
       tr.source_location_id::text,
       sloc.code AS source_location_code,
       sloc.name AS source_location_name,
       tr.destination_location_id::text,
       dloc.code AS destination_location_code,
       dloc.name AS destination_location_name,
       tr.state,
       tr.rfid_count,
       tr.manual_count,
       (
         SELECT COUNT(*)::int FROM items i
         WHERE i.transfer_id = tr.id AND i.status = 'in-transit'
       ) AS rfid_pending,
       (
         SELECT COALESCE(SUM(qty_delta),0)::int FROM inventory_adjustments ia
         WHERE ia.transfer_id = tr.id
           AND ia.side = 'destination' AND ia.state = 'in-transit'
       ) AS manual_pending,
       tr.created_at::text,
       u.email AS created_by_name,
       tr.notes
     FROM transfer_records tr
     INNER JOIN locations sloc ON sloc.id = tr.source_location_id
     INNER JOIN locations dloc ON dloc.id = tr.destination_location_id
     LEFT JOIN users u ON u.id = tr.created_by
     WHERE tr.tenant_id = $1::uuid
       AND tr.destination_location_id = $2::uuid
       AND tr.state IN ('in-transit', 'partially_received')
     ORDER BY tr.created_at DESC
     LIMIT 100`,
    [tenantId, destinationLocationId],
  );
  return r.rows;
}

export type TransferDetailRow = {
  id: string;
  state: string;
  source_location_id: string;
  destination_location_id: string;
  source_location_code: string;
  destination_location_code: string;
  rfid: Array<{
    epc: string;
    serial_number: string | null;
    custom_sku_id: string;
    sku: string;
    sku_ls_system_id: string | null;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    retail_price: string | null;
    received: boolean;
  }>;
  manual: Array<{
    adjustment_id: string;
    custom_sku_id: string;
    sku: string;
    sku_ls_system_id: string | null;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    retail_price: string | null;
    qty: number;
    state: string;
  }>;
};

export async function getTransferDetail(
  pool: Pool,
  tenantId: string,
  transferId: string,
): Promise<TransferDetailRow | null> {
  const tr = await pool.query<{
    id: string;
    state: string;
    source_location_id: string;
    destination_location_id: string;
    source_location_code: string;
    destination_location_code: string;
  }>(
    `SELECT
       tr.id::text,
       tr.state,
       tr.source_location_id::text,
       tr.destination_location_id::text,
       sl.code AS source_location_code,
       dl.code AS destination_location_code
     FROM transfer_records tr
     INNER JOIN locations sl ON sl.id = tr.source_location_id
     INNER JOIN locations dl ON dl.id = tr.destination_location_id
     WHERE tr.id = $1::uuid AND tr.tenant_id = $2::uuid LIMIT 1`,
    [transferId, tenantId],
  );
  const t = tr.rows[0];
  if (!t) return null;

  const rfidRows = await pool.query<{
    epc: string;
    serial_number: string | null;
    custom_sku_id: string;
    sku: string;
    sku_ls_system_id: string | null;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    retail_price: string | null;
    status: string;
  }>(
    `SELECT
       i.epc,
       i.serial_number::text AS serial_number,
       i.custom_sku_id::text,
       cs.sku,
       cs.ls_system_id::text AS sku_ls_system_id,
       m.description AS name,
       cs.color_code AS color,
       cs.size,
       COALESCE(cs.upc, m.upc) AS upc,
       cs.retail_price::text AS retail_price,
       i.status
     FROM items i
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     WHERE i.transfer_id = $1::uuid
     ORDER BY cs.sku ASC`,
    [transferId],
  );

  const manualRows = await pool.query<{
    adjustment_id: string;
    custom_sku_id: string;
    sku: string;
    sku_ls_system_id: string | null;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    retail_price: string | null;
    qty_delta: number;
    state: string;
  }>(
    `SELECT
       ia.id::text AS adjustment_id,
       ia.custom_sku_id::text,
       cs.sku,
       cs.ls_system_id::text AS sku_ls_system_id,
       m.description AS name,
       cs.color_code AS color,
       cs.size,
       COALESCE(cs.upc, m.upc) AS upc,
       cs.retail_price::text AS retail_price,
       ia.qty_delta,
       ia.state
     FROM inventory_adjustments ia
     INNER JOIN custom_skus cs ON cs.id = ia.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     WHERE ia.transfer_id = $1::uuid AND ia.side = 'destination'
     ORDER BY cs.sku ASC`,
    [transferId],
  );

  return {
    id: t.id,
    state: t.state,
    source_location_id: t.source_location_id,
    destination_location_id: t.destination_location_id,
    source_location_code: t.source_location_code,
    destination_location_code: t.destination_location_code,
    rfid: rfidRows.rows.map((r) => ({
      epc: r.epc,
      serial_number: r.serial_number,
      custom_sku_id: r.custom_sku_id,
      sku: r.sku,
      sku_ls_system_id: r.sku_ls_system_id,
      name: r.name,
      color: r.color,
      size: r.size,
      upc: r.upc,
      retail_price: r.retail_price,
      received: r.status === "in-stock",
    })),
    manual: manualRows.rows.map((r) => ({
      adjustment_id: r.adjustment_id,
      custom_sku_id: r.custom_sku_id,
      sku: r.sku,
      sku_ls_system_id: r.sku_ls_system_id,
      name: r.name,
      color: r.color,
      size: r.size,
      upc: r.upc,
      retail_price: r.retail_price,
      qty: r.qty_delta,
      state: r.state,
    })),
  };
}

/* ===========================================================================
 *  Receive (Transfer In) — flip in-transit → in-stock + auto-bin
 * ========================================================================= */

export const transferReceiveSchema = z.object({
  transferId: z.string().uuid(),
  epcs: z
    .array(epcHex24)
    .max(500)
    .transform((a) => [...new Set(a)])
    .default([]),
  manualConfirms: z
    .array(
      z.object({
        adjustmentId: z.string().uuid(),
      }),
    )
    .max(500)
    .default([]),
});

export type TransferReceiveBody = z.infer<typeof transferReceiveSchema>;

export type TransferReceiveResult = {
  transferId: string;
  rfidReceived: number;
  manualReceived: number;
  state: string;
};

/**
 * Receive: flip RFID items in this transfer back to in-stock, auto-route each
 * to the bin where most existing in-stock items of the same custom_sku live
 * at the destination (NULL if no existing presence). Also flip the matching
 * destination-side manual adjustments from in-transit to settled.
 */
export async function commitReceive(
  client: PoolClient,
  session: SessionPayload,
  body: TransferReceiveBody,
): Promise<TransferReceiveResult> {
  const { transferId, epcs, manualConfirms } = body;

  const tr = await client.query<{
    id: string;
    destination_location_id: string;
    state: string;
    rfid_count: number;
    manual_count: number;
  }>(
    `SELECT id::text, destination_location_id::text, state, rfid_count, manual_count
     FROM transfer_records
     WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [transferId, session.tid],
  );
  const t = tr.rows[0];
  if (!t) throw new Error("BAD_REQUEST:Transfer not found");
  if (t.state === "received" || t.state === "cancelled") {
    throw new Error(`BAD_REQUEST:Transfer is ${t.state}`);
  }

  // 1. RFID side — auto-route each EPC to the bin most-used by its custom_sku
  // at the destination location. NULL when the SKU has no presence yet.
  let rfidReceived = 0;
  if (epcs.length > 0) {
    // Validate each EPC belongs to this transfer + still in-transit.
    const check = await client.query<{ epc: string; status: string; transfer_id: string | null }>(
      `SELECT epc, status, transfer_id::text FROM items WHERE epc = ANY($1::text[])`,
      [epcs],
    );
    for (const e of epcs) {
      const row = check.rows.find((r) => r.epc === e);
      if (!row) throw new Error(`BAD_REQUEST:EPC ${e} not found`);
      if (row.status !== "in-transit" || row.transfer_id !== transferId) {
        throw new Error(`BAD_REQUEST:EPC ${e} is not part of this in-transit transfer`);
      }
    }

    // Pick "most used bin" per EPC's custom_sku at the destination.
    const upd = await client.query(
      `WITH preferred AS (
         SELECT
           it.epc,
           (
             SELECT bx.bin_id::text
             FROM (
               SELECT i.bin_id, COUNT(*) AS c
               FROM items i
               WHERE i.custom_sku_id = it.custom_sku_id
                 AND i.location_id = $1::uuid
                 AND i.status = 'in-stock'
                 AND i.bin_id IS NOT NULL
               GROUP BY i.bin_id
               ORDER BY c DESC, i.bin_id::text ASC
               LIMIT 1
             ) bx
           ) AS bin_id
         FROM items it
         WHERE it.epc = ANY($2::text[])
       )
       UPDATE items i
       SET status = 'in-stock',
           bin_id = preferred.bin_id::uuid
       FROM preferred
       WHERE i.epc = preferred.epc`,
      [t.destination_location_id, epcs],
    );
    rfidReceived = upd.rowCount ?? 0;
  }

  // 2. Manual side — settle named destination-side adjustments.
  let manualReceived = 0;
  if (manualConfirms.length > 0) {
    const ids = manualConfirms.map((m) => m.adjustmentId);
    const upd = await client.query<{ qty_delta: number }>(
      `UPDATE inventory_adjustments
       SET state = 'settled', settled_at = now()
       WHERE id = ANY($1::uuid[])
         AND transfer_id = $2::uuid
         AND tenant_id = $3::uuid
         AND side = 'destination'
         AND state = 'in-transit'
       RETURNING qty_delta`,
      [ids, transferId, session.tid],
    );
    manualReceived = upd.rows.reduce((acc, r) => acc + r.qty_delta, 0);
  }

  // 3. Recompute transfer state — fully received iff no in-transit items AND
  // no in-transit destination-side adjustments remain on this transfer.
  const remRfid = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM items
     WHERE transfer_id = $1::uuid AND status = 'in-transit'`,
    [transferId],
  );
  const remManual = await client.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM inventory_adjustments
     WHERE transfer_id = $1::uuid AND side = 'destination' AND state = 'in-transit'`,
    [transferId],
  );
  const stillPending =
    Number(remRfid.rows[0]?.c ?? 0) > 0 || Number(remManual.rows[0]?.c ?? 0) > 0;
  const newState = stillPending ? "partially_received" : "received";

  await client.query(
    `UPDATE transfer_records
     SET state = $1,
         received_by = COALESCE(received_by, $2::uuid),
         received_at = COALESCE(received_at, now())
     WHERE id = $3::uuid`,
    [newState, session.sub, transferId],
  );

  await client.query(
    `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
     VALUES ($1::uuid, $2::uuid, 'rfid_transfer_received', 'items', $3::jsonb)`,
    [
      session.tid,
      session.sub,
      JSON.stringify({
        transfer_id: transferId,
        rfid_received: rfidReceived,
        manual_received: manualReceived,
        new_state: newState,
      }),
    ],
  );

  return {
    transferId,
    rfidReceived,
    manualReceived,
    state: newState,
  };
}
