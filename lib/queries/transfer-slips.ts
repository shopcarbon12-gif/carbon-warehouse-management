import type { Pool } from "pg";

export type TransferSlipRow = {
  slip_number: number;
  source_loc: string;
  dest_loc: string;
  status: string;
  ls_transfer_id: string | null;
  created_at: string;
};

export type TransferItemRow = {
  slip_number: number;
  epc: string;
  status: string;
};

export async function createTransferSlip(
  pool: Pool,
  tenantId: string,
  input: { source_loc: string; dest_loc: string; location_id: string | null },
): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `INSERT INTO transfer_slips (tenant_id, location_id, source_loc, dest_loc, status)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'draft')
     RETURNING slip_number::text AS n`,
    [tenantId, input.location_id, input.source_loc.trim(), input.dest_loc.trim()],
  );
  const n = r.rows[0]?.n;
  if (!n) throw new Error("createTransferSlip failed");
  return Number.parseInt(n, 10);
}

export async function listTransferSlips(pool: Pool, tenantId: string): Promise<TransferSlipRow[]> {
  const r = await pool.query<{
    slip_number: string;
    source_loc: string;
    dest_loc: string;
    status: string;
    ls_transfer_id: string | null;
    created_at: Date;
  }>(
    `SELECT slip_number::text, source_loc, dest_loc, status, ls_transfer_id, created_at
     FROM transfer_slips
     WHERE tenant_id = $1::uuid
     ORDER BY slip_number DESC`,
    [tenantId],
  );
  return r.rows.map((row) => ({
    slip_number: Number.parseInt(row.slip_number, 10),
    source_loc: row.source_loc,
    dest_loc: row.dest_loc,
    status: row.status,
    ls_transfer_id: row.ls_transfer_id,
    created_at: row.created_at.toISOString(),
  }));
}

export async function getTransferSlip(
  pool: Pool,
  tenantId: string,
  slipNumber: number,
): Promise<(TransferSlipRow & { items: TransferItemRow[] }) | null> {
  const s = await pool.query<{
    slip_number: string;
    source_loc: string;
    dest_loc: string;
    status: string;
    ls_transfer_id: string | null;
    created_at: Date;
  }>(
    `SELECT slip_number::text, source_loc, dest_loc, status, ls_transfer_id, created_at
     FROM transfer_slips
     WHERE tenant_id = $1::uuid AND slip_number = $2::int
     LIMIT 1`,
    [tenantId, slipNumber],
  );
  const head = s.rows[0];
  if (!head) return null;
  const items = await pool.query<{ slip_number: string; epc: string; status: string }>(
    `SELECT slip_number::text, epc, status FROM transfer_items WHERE slip_number = $1::int`,
    [slipNumber],
  );
  return {
    slip_number: Number.parseInt(head.slip_number, 10),
    source_loc: head.source_loc,
    dest_loc: head.dest_loc,
    status: head.status,
    ls_transfer_id: head.ls_transfer_id,
    created_at: head.created_at.toISOString(),
    items: items.rows.map((i) => ({
      slip_number: Number.parseInt(i.slip_number, 10),
      epc: i.epc,
      status: i.status,
    })),
  };
}

export type TransferSlipExportRow = {
  epc: string;
  alu: string;
  name: string;
  sent: number;
  received: number;
  missing: number;
};

/**
 * One row per slip line; Sent/Received/Missing are 0/1 flags for CSV export.
 */
export async function getTransferSlipExportRows(
  pool: Pool,
  tenantId: string,
  slipNumber: number,
): Promise<TransferSlipExportRow[]> {
  const head = await pool.query(
    `SELECT 1 FROM transfer_slips WHERE tenant_id = $1::uuid AND slip_number = $2::int LIMIT 1`,
    [tenantId, slipNumber],
  );
  if (!head.rows[0]) return [];

  const r = await pool.query<{
    epc: string;
    ti_status: string;
    sku: string | null;
    title: string | null;
  }>(
    `SELECT
       ti.epc,
       ti.status AS ti_status,
       cs.sku,
       COALESCE(NULLIF(trim(m.description), ''), cs.sku, '') AS title
     FROM transfer_items ti
     LEFT JOIN items i ON upper(trim(i.epc)) = upper(trim(ti.epc))
     LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
     LEFT JOIN matrices m ON m.id = cs.matrix_id
     INNER JOIN transfer_slips ts ON ts.slip_number = ti.slip_number AND ts.tenant_id = $2::uuid
     WHERE ti.slip_number = $1::int
     ORDER BY ti.epc ASC`,
    [slipNumber, tenantId],
  );

  return r.rows.map((row) => {
    const st = (row.ti_status || "").toLowerCase();
    const received = st === "received" || st === "live" ? 1 : 0;
    const missing = st === "missing" ? 1 : 0;
    return {
      epc: row.epc,
      alu: row.sku?.trim() || "",
      name: row.title?.trim() || "",
      sent: 1,
      received,
      missing,
    };
  });
}

/**
 * Aggregate slip EPCs → Lightspeed **itemID** + **toSend** using `items` → `custom_skus.ls_item_id`.
 * EPCs with no WMS item or no `ls_item_id` are counted in **unresolved_line_count**.
 */
export async function aggregateLightspeedTransferLinesFromSlipEpcs(
  pool: Pool,
  tenantId: string,
  slipNumber: number,
): Promise<{
  lines: { itemID: number; toSend: number }[];
  unresolved_line_count: number;
}> {
  const ok = await pool.query(
    `SELECT 1 FROM transfer_slips WHERE tenant_id = $1::uuid AND slip_number = $2::int LIMIT 1`,
    [tenantId, slipNumber],
  );
  if (!ok.rows[0]) {
    return { lines: [], unresolved_line_count: 0 };
  }

  const agg = await pool.query<{ ls_item_id: string; to_send: string }>(
    `SELECT
       cs.ls_item_id::text AS ls_item_id,
       COUNT(*)::text AS to_send
     FROM transfer_items ti
     INNER JOIN transfer_slips ts
       ON ts.slip_number = ti.slip_number AND ts.tenant_id = $1::uuid
     INNER JOIN items i ON upper(trim(i.epc)) = upper(trim(ti.epc))
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     WHERE ti.slip_number = $2::int
       AND cs.ls_item_id IS NOT NULL
     GROUP BY cs.ls_item_id`,
    [tenantId, slipNumber],
  );

  const lines: { itemID: number; toSend: number }[] = [];
  for (const row of agg.rows) {
    const itemID = Number.parseInt(row.ls_item_id, 10);
    const toSend = Number.parseInt(row.to_send, 10);
    if (!Number.isFinite(itemID) || itemID <= 0) continue;
    if (!Number.isFinite(toSend) || toSend <= 0) continue;
    lines.push({ itemID, toSend: Math.min(999_999, Math.floor(toSend)) });
  }

  const total = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM transfer_items ti
     INNER JOIN transfer_slips ts ON ts.slip_number = ti.slip_number AND ts.tenant_id = $1::uuid
     WHERE ti.slip_number = $2::int`,
    [tenantId, slipNumber],
  );
  const matched = await pool.query<{ c: string }>(
    `SELECT COUNT(*)::text AS c
     FROM transfer_items ti
     INNER JOIN transfer_slips ts ON ts.slip_number = ti.slip_number AND ts.tenant_id = $1::uuid
     INNER JOIN items i ON upper(trim(i.epc)) = upper(trim(ti.epc))
     INNER JOIN custom_skus cs ON cs.id = i.custom_sku_id
     WHERE ti.slip_number = $2::int
       AND cs.ls_item_id IS NOT NULL`,
    [tenantId, slipNumber],
  );
  const totalN = Number(total.rows[0]?.c ?? 0) || 0;
  const matchedN = Number(matched.rows[0]?.c ?? 0) || 0;
  const unresolved_line_count = Math.max(0, totalN - matchedN);

  return { lines, unresolved_line_count };
}

export async function addTransferItems(
  pool: Pool,
  tenantId: string,
  slipNumber: number,
  epcs: string[],
): Promise<void> {
  const ok = await pool.query(
    `SELECT 1 FROM transfer_slips WHERE tenant_id = $1::uuid AND slip_number = $2::int LIMIT 1`,
    [tenantId, slipNumber],
  );
  if (!ok.rows[0]) throw new Error("NOT_FOUND");
  for (const epc of epcs) {
    const e = epc.trim();
    if (!e) continue;
    await pool.query(
      `INSERT INTO transfer_items (slip_number, epc, status)
       VALUES ($1::int, $2, 'pending')
       ON CONFLICT (slip_number, epc) DO NOTHING`,
      [slipNumber, e],
    );
  }
}

/**
 * Mark scanned EPCs on a slip as received or missing (receiving / closed-loop handheld).
 */
/** Persist Lightspeed R-Series `Inventory/Transfer` id after a successful create. */
export async function setTransferSlipLsTransferId(
  pool: Pool,
  tenantId: string,
  slipNumber: number,
  lsTransferId: string,
): Promise<boolean> {
  const r = await pool.query(
    `UPDATE transfer_slips
     SET ls_transfer_id = $3, updated_at = now()
     WHERE tenant_id = $1::uuid AND slip_number = $2::int`,
    [tenantId, slipNumber, lsTransferId.trim()],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function setTransferItemsOutcome(
  pool: Pool,
  tenantId: string,
  slipNumber: number,
  epcs: string[],
  outcome: "received" | "missing",
): Promise<number> {
  const ok = await pool.query(
    `SELECT 1 FROM transfer_slips WHERE tenant_id = $1::uuid AND slip_number = $2::int LIMIT 1`,
    [tenantId, slipNumber],
  );
  if (!ok.rows[0]) throw new Error("NOT_FOUND");
  const status = outcome === "received" ? "received" : "missing";
  let updated = 0;
  for (const raw of epcs) {
    const e = raw.trim();
    if (!e) continue;
    const r = await pool.query(
      `UPDATE transfer_items ti
       SET status = $4
       FROM transfer_slips ts
       WHERE ti.slip_number = ts.slip_number
         AND ts.tenant_id = $1::uuid
         AND ts.slip_number = $2::int
         AND upper(trim(ti.epc)) = upper(trim($3))`,
      [tenantId, slipNumber, e, status],
    );
    updated += r.rowCount ?? 0;
  }
  return updated;
}
