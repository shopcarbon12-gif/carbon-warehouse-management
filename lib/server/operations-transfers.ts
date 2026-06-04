import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ingestEpcs } from "@/lib/server/epc-ingress";
import { decodeEpc } from "@/lib/server/epc-decode";

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
  /** Null when the EPC is tag_killed / uncommissioned and no catalog match
   *  was found by decoded system_id. UI should show "(no SKU)" or hide. */
  sku: string | null;
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
  custom_sku_id: string | null;
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
    sku: string | null;
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
    custom_sku_id: string | null;
    sku_ls_system_id: string | null;
  }>(
    // LEFT JOIN custom_skus so tag_killed / uncommissioned items still come
    // back. Without this, the antenna-test page (and any other "show me
    // everything" view) sees EMPTY catalog data for every defective EPC.
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
     LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     LEFT JOIN bins b ON b.id = i.bin_id
     WHERE i.epc = ANY($2::text[])`,
    [tenantId, norm],
  );

  const rows: TransferLookupRow[] = r.rows.map((row) => ({
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

  // Second pass: for rows that came back without a SKU (tag_killed / unknown
  // system_id at ingress time), decode the EPC and look up custom_skus by
  // ls_system_id. This catches the scenario where the catalog has since
  // caught up to a system_id that didn't exist during the original ingress
  // — the UI shows the proper sku/name/color/size instead of an empty row.
  await enrichRowsWithDecodedFallback(pool, tenantId, rows);
  return rows;
}

async function enrichRowsWithDecodedFallback(
  pool: Pool,
  tenantId: string,
  rows: TransferLookupRow[],
): Promise<void> {
  const empty = rows.filter((r) => r.sku === null || r.sku === undefined);
  if (empty.length === 0) return;

  const cfgRow = await pool.query<{
    prefix_hex: string;
    prefix_bits: number;
    asset_bits: number;
    serial_bits: number;
    asset_padding_digits: number;
  }>(
    `SELECT prefix_hex, prefix_bits, asset_bits, serial_bits, asset_padding_digits
       FROM tenant_epc_config WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const cfg = cfgRow.rows[0];
  if (!cfg) return;

  const decodedConfig = {
    prefixHex: cfg.prefix_hex,
    prefixBits: cfg.prefix_bits,
    assetBits: cfg.asset_bits,
    serialBits: cfg.serial_bits,
    assetPaddingDigits: cfg.asset_padding_digits,
  };

  const sysIdToRows = new Map<string, TransferLookupRow[]>();
  for (const row of empty) {
    const decoded = decodeEpc(row.epc, decodedConfig);
    if (!decoded.valid || decoded.systemId === null) continue;
    const sid = decoded.systemId.toString();
    if (row.sku_ls_system_id === null) row.sku_ls_system_id = sid;
    const arr = sysIdToRows.get(sid) ?? [];
    arr.push(row);
    sysIdToRows.set(sid, arr);
  }
  if (sysIdToRows.size === 0) return;

  const ids = [...sysIdToRows.keys()];
  const cat = await pool.query<{
    ls_system_id: string;
    sku: string;
    color: string | null;
    size: string | null;
    asset_id: string | null;
    retail_price: string | null;
    sku_upc: string | null;
    matrix_upc: string | null;
    name: string | null;
    vendor: string | null;
    custom_sku_id: string;
  }>(
    `SELECT cs.ls_system_id::text AS ls_system_id,
            cs.sku,
            cs.color_code AS color,
            cs.size,
            cs.asset_id,
            cs.retail_price::text AS retail_price,
            cs.upc AS sku_upc,
            m.upc AS matrix_upc,
            m.description AS name,
            m.vendor,
            cs.id::text AS custom_sku_id
       FROM custom_skus cs
       LEFT JOIN matrices m ON m.id = cs.matrix_id
      WHERE cs.ls_system_id::text = ANY($1::text[])`,
    [ids],
  );

  for (const cr of cat.rows) {
    const targets = sysIdToRows.get(cr.ls_system_id) ?? [];
    for (const row of targets) {
      row.sku = cr.sku;
      row.name = cr.name;
      row.color = cr.color;
      row.size = cr.size;
      row.upc = (cr.sku_upc && cr.sku_upc.trim()) || cr.matrix_upc || null;
      row.vendor = cr.vendor;
      row.retail_price = cr.retail_price;
      row.sku_ls_system_id = cr.ls_system_id;
      // Don't overwrite custom_sku_id on the items row — that's how the
      // catalog still surfaces proper data without re-binding the items
      // row (which is tag_killed for a reason).
    }
  }
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
  slipNumber: number | null;
  rfidCount: number;
  /** EPCs that were in-stock and flipped to in-transit. */
  liveCount: number;
  /** EPCs that shipped in a non-live status (damaged / tag_killed / …). */
  nonLiveCount: number;
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

  // Split the scanned EPCs into LIVE (in-stock → become in-transit) and
  // NON-LIVE (damaged / tag_killed / sold / stolen / …). Non-live items are
  // NOT blocked: they ship with the slip in their CURRENT status and are
  // inspected at the receive step. Every EPC must physically be at the source
  // location, and may not already be in transit on another slip.
  const liveEpcs: string[] = [];
  const nonLiveEpcs: string[] = [];
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
      if (r.location_id !== sourceLocationId) {
        throw new Error(
          `BAD_REQUEST:EPC ${r.epc} is not at the chosen source location.`,
        );
      }
      if (r.status === "in-transit") {
        throw new Error(
          `BAD_REQUEST:EPC ${r.epc} is already in transit on another slip.`,
        );
      }
      if (r.status === "in-stock") liveEpcs.push(r.epc);
      else nonLiveEpcs.push(r.epc);
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

  // 1. Create the transfer record. slip_number defaults to nextval() of the
  // 70000-start sequence (see migration 036).
  const trIns = await client.query<{ id: string; slip_number: string | null }>(
    `INSERT INTO transfer_records
       (tenant_id, source_location_id, destination_location_id, state,
        rfid_count, manual_count, created_by, notes)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'in-transit', $4, $5, $6::uuid, $7)
     RETURNING id::text, slip_number::text`,
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
  const slipNumberRaw = trIns.rows[0]!.slip_number;
  const slipNumber = slipNumberRaw == null ? null : Number(slipNumberRaw);

  // 2. Live items → in-transit. Non-live items KEEP their status. Both move to
  // the destination and attach to this transfer so they travel together; the
  // receive step flips found in-transit items to live and lets the operator
  // inspect each non-live arrival before closing the slip.
  let movedRfid = 0;
  if (liveEpcs.length > 0) {
    const upd = await client.query(
      `UPDATE items
       SET location_id = $1::uuid,
           bin_id = NULL,
           status = 'in-transit',
           transfer_id = $2::uuid
       WHERE epc = ANY($3::text[])`,
      [destinationLocationId, transferId, liveEpcs],
    );
    movedRfid = upd.rowCount ?? 0;
  }
  let movedNonLive = 0;
  if (nonLiveEpcs.length > 0) {
    const upd = await client.query(
      `UPDATE items
       SET location_id = $1::uuid,
           bin_id = NULL,
           transfer_id = $2::uuid
       WHERE epc = ANY($3::text[])`,
      [destinationLocationId, transferId, nonLiveEpcs],
    );
    movedNonLive = upd.rowCount ?? 0;
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
        slip_number: slipNumber,
        source_location: { id: src.id, code: src.code, name: src.name },
        destination_location: { id: dst.id, code: dst.code, name: dst.name },
        epcs,
        manual_lines: manualLines,
        rfid_count: movedRfid + movedNonLive,
        live_count: movedRfid,
        non_live_count: movedNonLive,
        manual_units: manualUnits,
        state: "in-transit",
      }),
    ],
  );

  return {
    transferId,
    slipNumber,
    rfidCount: movedRfid + movedNonLive,
    liveCount: movedRfid,
    nonLiveCount: movedNonLive,
    manualCount: manualUnits,
    auditId: audit.rows[0]?.id ?? "",
  };
}

/* ===========================================================================
 *  Pending transfers list (Transfer In page)
 * ========================================================================= */

export type PendingTransferRow = {
  id: string;
  slip_number: number | null;
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
    slip_number: string | null;
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
       tr.slip_number::text,
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
  return r.rows.map((row) => ({
    ...row,
    slip_number: row.slip_number == null ? null : Number(row.slip_number),
  }));
}

export type TransferDetailRow = {
  id: string;
  slip_number: number | null;
  state: string;
  created_at: string;
  source_location_id: string;
  destination_location_id: string;
  source_location_code: string;
  source_location_name: string;
  destination_location_code: string;
  destination_location_name: string;
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
    /** Current item status (in-transit / in-stock / damaged / tag_killed / …). */
    status: string;
    /** True when the item arrived in a non-live status (not in-transit, not
     *  in-stock) — these raise the inspect-before-close notice on receive. */
    arrived_non_live: boolean;
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
  created_by_email: string | null;
  created_by_first: string | null;
  created_by_last: string | null;
};

export async function getTransferDetail(
  pool: Pool,
  tenantId: string,
  transferId: string,
): Promise<TransferDetailRow | null> {
  const tr = await pool.query<{
    id: string;
    slip_number: string | null;
    state: string;
    created_at: string;
    source_location_id: string;
    destination_location_id: string;
    source_location_code: string;
    source_location_name: string;
    destination_location_code: string;
    destination_location_name: string;
    created_by_email: string | null;
    created_by_first: string | null;
    created_by_last: string | null;
  }>(
    `SELECT
       tr.id::text,
       tr.slip_number::text,
       tr.state,
       tr.created_at::text,
       tr.source_location_id::text,
       tr.destination_location_id::text,
       sl.code AS source_location_code,
       sl.name AS source_location_name,
       dl.code AS destination_location_code,
       dl.name AS destination_location_name,
       u.email AS created_by_email,
       u.first_name AS created_by_first,
       u.last_name AS created_by_last
     FROM transfer_records tr
     INNER JOIN locations sl ON sl.id = tr.source_location_id
     INNER JOIN locations dl ON dl.id = tr.destination_location_id
     LEFT JOIN users u ON u.id = tr.created_by
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
    slip_number: t.slip_number == null ? null : Number(t.slip_number),
    state: t.state,
    created_at: t.created_at,
    source_location_id: t.source_location_id,
    destination_location_id: t.destination_location_id,
    source_location_code: t.source_location_code,
    source_location_name: t.source_location_name,
    destination_location_code: t.destination_location_code,
    destination_location_name: t.destination_location_name,
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
      status: r.status,
      arrived_non_live: r.status !== "in-transit" && r.status !== "in-stock",
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
    created_by_email: t.created_by_email,
    created_by_first: t.created_by_first,
    created_by_last: t.created_by_last,
  };
}

/* ===========================================================================
 *  Reports — list of all transfer slips with search + filters
 * ========================================================================= */

export type TransferSlipReportRow = {
  id: string;
  slip_number: number | null;
  state: string;
  source_location_code: string;
  source_location_name: string;
  destination_location_code: string;
  destination_location_name: string;
  created_at: string;
  received_at: string | null;
  rfid_count: number;
  manual_count: number;
  sent_qty: number;
  received_qty: number;
  missing_qty: number;
  doc_number: string | null;
  ref_number: string | null;
  created_by_email: string | null;
};

export type TransferSlipReportFilters = {
  /** Optional case-insensitive search across slip#, EPC, custom SKU, UPC, item name. */
  q?: string;
  /** ISO date string (yyyy-mm-dd) — inclusive. */
  shippedFrom?: string;
  shippedTo?: string;
  receivedFrom?: string;
  receivedTo?: string;
  /** Optional filter on transfer_records.state. */
  state?: string;
  /** Outbound vs inbound view filter. Out = ship-from = session location, In = ship-to. */
  direction: "out" | "in";
  /** Operator's session location used to scope by direction. Admin can pass another. */
  scopeLocationId?: string;
  page: number;
  limit: number;
};

export type TransferSlipReportResult = {
  rows: TransferSlipReportRow[];
  total: number;
  status_counts: { all: number; pending: number; partially_received: number; received: number; cancelled: number };
};

export async function listTransferSlipReport(
  pool: Pool,
  tenantId: string,
  filters: TransferSlipReportFilters,
): Promise<TransferSlipReportResult> {
  const { q, shippedFrom, shippedTo, receivedFrom, receivedTo, state, direction, scopeLocationId, page, limit } = filters;
  const safeLimit = Math.min(500, Math.max(1, limit));
  const offset = Math.max(0, (page - 1) * safeLimit);

  const where: string[] = ["tr.tenant_id = $1::uuid"];
  const params: unknown[] = [tenantId];

  if (scopeLocationId) {
    if (direction === "out") {
      params.push(scopeLocationId);
      where.push(`tr.source_location_id = $${params.length}::uuid`);
    } else {
      params.push(scopeLocationId);
      where.push(`tr.destination_location_id = $${params.length}::uuid`);
    }
  }

  if (state && state !== "all") {
    params.push(state);
    where.push(`tr.state = $${params.length}`);
  }

  if (shippedFrom) {
    params.push(shippedFrom);
    where.push(`tr.created_at >= $${params.length}::timestamptz`);
  }
  if (shippedTo) {
    // Inclusive end-of-day.
    params.push(shippedTo);
    where.push(`tr.created_at < ($${params.length}::date + INTERVAL '1 day')`);
  }
  if (receivedFrom) {
    params.push(receivedFrom);
    where.push(`tr.received_at >= $${params.length}::timestamptz`);
  }
  if (receivedTo) {
    params.push(receivedTo);
    where.push(`tr.received_at < ($${params.length}::date + INTERVAL '1 day')`);
  }

  // Free-text search across slip#, EPC, sku, upc, item description.
  if (q && q.trim().length > 0) {
    params.push(`%${q.trim()}%`);
    const like = `$${params.length}`;
    params.push(q.trim());
    const exact = `$${params.length}`;
    where.push(`(
      CAST(tr.slip_number AS TEXT) = ${exact}
      OR EXISTS (
        SELECT 1 FROM items i
        INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
        LEFT JOIN matrices m ON m.id = cs.matrix_id
        WHERE i.transfer_id = tr.id
          AND (
            i.epc ILIKE ${like}
            OR cs.sku ILIKE ${like}
            OR COALESCE(cs.upc, m.upc) ILIKE ${like}
            OR m.description ILIKE ${like}
          )
      )
      OR EXISTS (
        SELECT 1 FROM inventory_adjustments ia
        INNER JOIN custom_skus cs ON cs.id = ia.custom_sku_id
        LEFT JOIN matrices m ON m.id = cs.matrix_id
        WHERE ia.transfer_id = tr.id
          AND ia.side = 'destination'
          AND (
            cs.sku ILIKE ${like}
            OR COALESCE(cs.upc, m.upc) ILIKE ${like}
            OR m.description ILIKE ${like}
          )
      )
    )`);
  }

  const whereSql = where.join(" AND ");

  const countQ = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM transfer_records tr WHERE ${whereSql}`,
    params,
  );
  const total = Number(countQ.rows[0]?.c ?? 0);

  // Status counts ignore the `state` filter so the pills always show all states.
  const statusWhere = where.filter((w) => !w.startsWith("tr.state =")).join(" AND ");
  const statusParams = state && state !== "all" ? params.slice(0, params.length - 0) : params;
  // Re-build params without the state value at index of the state where clause.
  // Simpler: re-run count without state filter.
  const sw: string[] = ["tr.tenant_id = $1::uuid"];
  const sp: unknown[] = [tenantId];
  if (scopeLocationId) {
    sp.push(scopeLocationId);
    sw.push(direction === "out"
      ? `tr.source_location_id = $${sp.length}::uuid`
      : `tr.destination_location_id = $${sp.length}::uuid`);
  }
  if (shippedFrom) { sp.push(shippedFrom); sw.push(`tr.created_at >= $${sp.length}::timestamptz`); }
  if (shippedTo)   { sp.push(shippedTo); sw.push(`tr.created_at < ($${sp.length}::date + INTERVAL '1 day')`); }
  if (receivedFrom){ sp.push(receivedFrom); sw.push(`tr.received_at >= $${sp.length}::timestamptz`); }
  if (receivedTo)  { sp.push(receivedTo); sw.push(`tr.received_at < ($${sp.length}::date + INTERVAL '1 day')`); }
  void statusWhere; void statusParams; // appease unused
  const statusQ = await pool.query<{
    state: string;
    c: string;
  }>(
    `SELECT tr.state, COUNT(*)::text AS c FROM transfer_records tr WHERE ${sw.join(" AND ")} GROUP BY tr.state`,
    sp,
  );
  const counts = { all: 0, pending: 0, partially_received: 0, received: 0, cancelled: 0 };
  for (const row of statusQ.rows) {
    const c = Number(row.c);
    counts.all += c;
    if (row.state === "in-transit") counts.pending += c;
    else if (row.state === "partially_received") counts.partially_received += c;
    else if (row.state === "received") counts.received += c;
    else if (row.state === "cancelled") counts.cancelled += c;
  }

  params.push(safeLimit);
  const limIdx = params.length;
  params.push(offset);
  const offIdx = params.length;

  const rowsQ = await pool.query<{
    id: string;
    slip_number: string | null;
    state: string;
    source_location_code: string;
    source_location_name: string;
    destination_location_code: string;
    destination_location_name: string;
    created_at: string;
    received_at: string | null;
    rfid_count: number;
    manual_count: number;
    received_qty: number;
    created_by_email: string | null;
  }>(
    `SELECT
       tr.id::text,
       tr.slip_number::text,
       tr.state,
       sl.code AS source_location_code,
       sl.name AS source_location_name,
       dl.code AS destination_location_code,
       dl.name AS destination_location_name,
       tr.created_at::text,
       tr.received_at::text,
       tr.rfid_count,
       tr.manual_count,
       (
         (SELECT COUNT(*)::int FROM items i WHERE i.transfer_id = tr.id AND i.status = 'in-stock')
         +
         COALESCE((
           SELECT SUM(qty_delta)::int FROM inventory_adjustments ia
           WHERE ia.transfer_id = tr.id
             AND ia.side = 'destination' AND ia.state = 'settled'
         ), 0)
       ) AS received_qty,
       u.email AS created_by_email
     FROM transfer_records tr
     INNER JOIN locations sl ON sl.id = tr.source_location_id
     INNER JOIN locations dl ON dl.id = tr.destination_location_id
     LEFT JOIN users u ON u.id = tr.created_by
     WHERE ${whereSql}
     ORDER BY tr.created_at DESC
     LIMIT $${limIdx} OFFSET $${offIdx}`,
    params,
  );

  return {
    rows: rowsQ.rows.map((r) => {
      const sent = (r.rfid_count ?? 0) + (r.manual_count ?? 0);
      const received = r.received_qty ?? 0;
      return {
        id: r.id,
        slip_number: r.slip_number == null ? null : Number(r.slip_number),
        state: r.state,
        source_location_code: r.source_location_code,
        source_location_name: r.source_location_name,
        destination_location_code: r.destination_location_code,
        destination_location_name: r.destination_location_name,
        created_at: r.created_at,
        received_at: r.received_at,
        rfid_count: r.rfid_count,
        manual_count: r.manual_count,
        sent_qty: sent,
        received_qty: received,
        missing_qty: Math.max(0, sent - received),
        doc_number: null,
        ref_number: null,
        created_by_email: r.created_by_email,
      };
    }),
    total,
    status_counts: counts,
  };
}

/* ===========================================================================
 *  Receive (Transfer In) — flip in-transit → in-stock + auto-bin
 * ========================================================================= */

/** Statuses an operator may assign to a non-live arrival during inspection. */
export const RECEIVE_INSPECT_STATUSES = [
  "in-stock",
  "damaged",
  "tag_killed",
  "sold",
  "stolen",
] as const;

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
  // Inspect-before-close decisions for items that arrived non-live. Each maps
  // an EPC on this slip to the status the operator set after inspection
  // ('in-stock' makes it live + auto-bins it; anything else keeps it off the
  // floor in that status).
  statuses: z
    .array(
      z.object({
        epc: epcHex24,
        status: z.enum(RECEIVE_INSPECT_STATUSES),
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
  /** Non-live arrivals whose status the operator set during inspection. */
  inspected: number;
  state: string;
  /** Echoed back so callers can fan out a live-mirror event to both ends. */
  sourceLocationId: string;
  destinationLocationId: string;
  slipNumber: number | null;
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
  const { transferId, epcs, manualConfirms, statuses } = body;

  const tr = await client.query<{
    id: string;
    source_location_id: string;
    destination_location_id: string;
    state: string;
    rfid_count: number;
    manual_count: number;
    slip_number: string | null;
  }>(
    `SELECT id::text, source_location_id::text, destination_location_id::text,
            state, rfid_count, manual_count, slip_number::text
     FROM transfer_records
     WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [transferId, session.tid],
  );
  const t = tr.rows[0];
  if (!t) throw new Error("BAD_REQUEST:Transfer not found");
  if (t.state === "received" || t.state === "cancelled") {
    throw new Error(`BAD_REQUEST:Transfer is ${t.state}`);
  }

  // 1. RFID side — flip scanned in-transit items to in-stock, plus apply any
  // inspect-before-close decisions for non-live arrivals. Each item that goes
  // live is auto-routed to the bin most-used by its custom_sku at the
  // destination (NULL when the SKU has no presence yet).

  // Validate scanned EPCs: must belong to this transfer + still in-transit.
  if (epcs.length > 0) {
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
  }

  // Validate inspect overrides: each must belong to this transfer (any status).
  if (statuses.length > 0) {
    const overrideEpcs = statuses.map((s) => s.epc);
    const ck = await client.query<{ epc: string; transfer_id: string | null }>(
      `SELECT epc, transfer_id::text FROM items WHERE epc = ANY($1::text[])`,
      [overrideEpcs],
    );
    for (const s of statuses) {
      const row = ck.rows.find((r) => r.epc === s.epc);
      if (!row || row.transfer_id !== transferId) {
        throw new Error(`BAD_REQUEST:EPC ${s.epc} is not part of this transfer`);
      }
    }
  }

  // Items that go live = scanned in-transit items + any inspect override the
  // operator explicitly set to 'in-stock'.
  const liveEpcs = [
    ...new Set([
      ...epcs,
      ...statuses.filter((s) => s.status === "in-stock").map((s) => s.epc),
    ]),
  ];
  let rfidReceived = 0;
  if (liveEpcs.length > 0) {
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
      [t.destination_location_id, liveEpcs],
    );
    rfidReceived = upd.rowCount ?? 0;
  }

  // Inspect overrides that are NOT 'in-stock' → set the chosen non-live status
  // (keeps the item off the floor at the destination).
  for (const s of statuses.filter((s) => s.status !== "in-stock")) {
    await client.query(
      `UPDATE items SET status = $1 WHERE epc = $2 AND transfer_id = $3::uuid`,
      [s.status, s.epc, transferId],
    );
  }
  const inspected = statuses.length;

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
        inspected,
        new_state: newState,
      }),
    ],
  );

  return {
    transferId,
    rfidReceived,
    manualReceived,
    inspected,
    state: newState,
    sourceLocationId: t.source_location_id,
    destinationLocationId: t.destination_location_id,
    slipNumber: t.slip_number == null ? null : Number(t.slip_number),
  };
}
