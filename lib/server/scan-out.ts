/**
 * Scan-out: the item being sent to a customer is scanned and its tag becomes
 * `sold`. Every action is recorded twice — a STATUS_CHANGE row in
 * inventory_audit_logs (so Status & tag logs shows it) and a scan_out_events
 * row carrying the item as it was (Reports → Scan-out log; migration 0099).
 *
 * Only `in-stock` (shown as LIVE) or `unknown` tags can be scanned out: an
 * online order marks a placeholder tag `unknown`, and the tag actually packed
 * may be that one or another LIVE one of the same item.
 */
import type { Pool } from "pg";
import { shortName } from "@/lib/format-name";

export const SCAN_OUT_FROM = ["in-stock", "unknown"] as const;

export type ScanOutItem = {
  epc: string;
  status: string | null;
  serial: string | null;
  customSkuId: string | null;
  sku: string | null;
  upc: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  bin: string | null;
};

const ITEM_SQL = `
  SELECT i.epc, i.status, i.serial_number::text AS serial,
         cs.id::text AS custom_sku_id, cs.sku, COALESCE(NULLIF(cs.upc, ''), m.upc) AS upc,
         m.description AS name, cs.color_code AS color, cs.size,
         -- The tag's own bin; else where this item's LIVE tags mostly are; else
         -- its assigned home bin — the same places the catalog shows.
         COALESCE(
           b.code,
           (SELECT b2.code FROM items i2 JOIN bins b2 ON b2.id = i2.bin_id
             WHERE i2.custom_sku_id = cs.id AND i2.status = 'in-stock' AND b2.archived_at IS NULL
             GROUP BY b2.code ORDER BY count(*) DESC, b2.code LIMIT 1),
           (SELECT b3.code FROM bins b3 WHERE b3.id = cs.assigned_bin_id AND b3.archived_at IS NULL)
         ) AS bin
    FROM items i
    LEFT JOIN custom_skus cs ON cs.id = i.custom_sku_id
    LEFT JOIN matrices m ON m.id = cs.matrix_id
    LEFT JOIN bins b ON b.id = i.bin_id`;

type ItemRow = {
  epc: string;
  status: string;
  serial: string | null;
  custom_sku_id: string | null;
  sku: string | null;
  upc: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  bin: string | null;
};

const toItem = (r: ItemRow): ScanOutItem => ({
  epc: r.epc,
  status: r.status,
  serial: r.serial,
  customSkuId: r.custom_sku_id,
  sku: r.sku,
  upc: r.upc,
  name: r.name,
  color: r.color,
  size: r.size,
  bin: r.bin,
});

export function cleanEpcs(raw: unknown, max = 200): string[] {
  const list = Array.isArray(raw) ? raw : [];
  const out = new Set<string>();
  for (const e of list) {
    const v = String(e ?? "").replace(/\s/g, "").toUpperCase();
    if (/^[0-9A-F]{24}$/.test(v)) out.add(v);
    if (out.size >= max) break;
  }
  return [...out];
}

/** Full item details for tags the reader saw. Unknown EPCs come back with nulls. */
export async function lookupItems(pool: Pool, epcs: string[]): Promise<ScanOutItem[]> {
  if (!epcs.length) return [];
  const r = await pool.query<ItemRow>(`${ITEM_SQL} WHERE i.epc = ANY($1::text[])`, [epcs]);
  const found = new Map(r.rows.map((row) => [row.epc, toItem(row)]));
  return epcs.map(
    (epc) =>
      found.get(epc) ?? { epc, status: null, serial: null, customSkuId: null, sku: null, upc: null, name: null, color: null, size: null, bin: null },
  );
}

type Who = { tenantId: string; userId: string; locationId: string | null };
type OrderRef = { orderId?: string | null; orderName?: string | null; returnId?: string | null; returnName?: string | null };

async function logEvent(
  q: Pick<Pool, "query">,
  who: Who,
  action: "reader_start" | "reader_stop" | "scan_out" | "rejected" | "undo" | "scan_in",
  item: Partial<ScanOutItem> & { epc?: string | null },
  extra: OrderRef & { oldStatus?: string | null; newStatus?: string | null; reader?: string | null; rssi?: number | null; detail?: string | null },
) {
  await q.query(
    `INSERT INTO scan_out_events (tenant_id, location_id, user_id, action, epc, old_status, new_status,
       custom_sku_id, sku, upc, item_name, color, size, bin, order_id, order_name, reader, rssi, detail, return_id, return_name)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      who.tenantId, who.locationId, who.userId, action, item.epc ?? null, extra.oldStatus ?? null, extra.newStatus ?? null,
      item.customSkuId ?? null, item.sku ?? null, item.upc ?? null, item.name ?? null, item.color ?? null, item.size ?? null,
      item.bin ?? null, extra.orderId ?? null, extra.orderName ?? null, extra.reader ?? null,
      typeof extra.rssi === "number" ? Math.round(extra.rssi) : null, extra.detail ?? null,
      extra.returnId ?? null, extra.returnName ?? null,
    ],
  );
}

export async function logReader(pool: Pool, who: Who, action: "reader_start" | "reader_stop", reader: string, order: OrderRef) {
  await logEvent(pool, who, action, {}, { ...order, reader });
}

export type ScanOutResult = ScanOutItem & { ok: boolean; oldStatus: string | null; error?: string };

/**
 * Scan out each tag in its own transaction — one bad tag must not undo the
 * others — locking the row so two stations cannot sell the same tag twice.
 */
export async function scanOut(
  pool: Pool,
  who: Who,
  epcs: string[],
  ctx: OrderRef & { reader?: string | null; rssi?: Record<string, number> },
): Promise<ScanOutResult[]> {
  const out: ScanOutResult[] = [];
  for (const epc of epcs) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query<ItemRow>(`${ITEM_SQL} WHERE i.epc = $1 FOR UPDATE OF i`, [epc]);
      const row = cur.rows[0];
      const item = row ? toItem(row) : ({ epc, status: null, serial: null, customSkuId: null, sku: null, upc: null, name: null, color: null, size: null, bin: null } as ScanOutItem);
      const rssi = ctx.rssi?.[epc] ?? null;
      if (!row || !(SCAN_OUT_FROM as readonly string[]).includes(row.status)) {
        const error = !row ? "This tag is not in the WMS." : row.status === "sold" ? "Already scanned out (sold)." : `This tag is ${row.status === "in-stock" ? "LIVE" : row.status.toUpperCase()}, not something that can be scanned out.`;
        await logEvent(client, who, "rejected", item, { ...ctx, oldStatus: row?.status ?? null, newStatus: null, rssi, detail: error });
        await client.query("COMMIT");
        out.push({ ...item, ok: false, oldStatus: row?.status ?? null, error });
        continue;
      }
      await client.query(`UPDATE items SET status = 'sold', last_seen_at = now() WHERE epc = $1`, [epc]);
      const reason = ctx.orderName ? `scan_out ${ctx.orderName}` : "scan_out";
      await client.query(
        `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
         VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, $3, 'sold', $4, NULL, $5::uuid, $6)`,
        [who.tenantId, epc, row.status, reason, who.userId, ctx.reader ?? null],
      );
      // The order held a LIVE tag of this item as UNKNOWN (orders/paid, or an approved
      // exchange) until the real piece was known. A LIVE piece scanned out is now SOLD
      // itself, so one held tag goes back to LIVE right away. (A held tag scanned out
      // itself was that placeholder — nothing to release.)
      let detail: string | null = null;
      if (ctx.orderId && row.status === "in-stock" && row.custom_sku_id) {
        const held = await client.query<{ epc: string }>(
          `SELECT i.epc FROM items i
            WHERE i.custom_sku_id = $2::uuid AND i.status = 'unknown' AND i.epc <> $3
              AND i.epc IN (SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(e->'epcs') = 'array' THEN e->'epcs' ELSE '[]'::jsonb END)
                              FROM shopify_sale_events s, jsonb_array_elements(CASE WHEN jsonb_typeof(s.detail) = 'array' THEN s.detail ELSE '[]'::jsonb END) e
                             WHERE s.order_id = $1)
            ORDER BY i.epc LIMIT 1 FOR UPDATE OF i SKIP LOCKED`,
          [ctx.orderId, row.custom_sku_id, epc],
        );
        const h = held.rows[0]?.epc;
        if (h) {
          await client.query(`UPDATE items SET status = 'in-stock' WHERE epc = $1`, [h]);
          await client.query(
            `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
             VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, 'unknown', 'in-stock', $3, NULL, $4::uuid, $5)`,
            [who.tenantId, h, `scan_out_release ${ctx.returnName ?? ctx.orderName ?? ""} (${epc} shipped)`.trim(), who.userId, ctx.reader ?? null],
          );
          detail = `Held tag ${h} back to LIVE`;
        }
      }
      await logEvent(client, who, "scan_out", item, { ...ctx, oldStatus: row.status, newStatus: "sold", rssi, detail });
      await client.query("COMMIT");
      out.push({ ...item, status: "sold", ok: true, oldStatus: row.status });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      out.push({ epc, status: null, serial: null, customSkuId: null, sku: null, upc: null, name: null, color: null, size: null, bin: null, ok: false, oldStatus: null, error: e instanceof Error ? e.message : "Database error" });
    } finally {
      client.release();
    }
  }
  return out;
}

/** What a returned piece may be when it comes back: IN TRANSIT (set when the return was approved), SOLD, the order's UNKNOWN placeholder, or RETURN. */
export const SCAN_IN_FROM = ["in-transit", "sold", "unknown", "return"] as const;

/**
 * Scan in returned pieces (Shopify → Returns): each tag must be an item on the
 * return (`allowed`: custom_sku_id → how many may still come in) and SOLD,
 * UNKNOWN or RETURN; it becomes LIVE. The read itself proves the tag works.
 */
export async function scanIn(
  pool: Pool,
  who: Who,
  epcs: string[],
  ctx: OrderRef & { reader?: string | null; rssi?: Record<string, number>; allowed: Map<string, number> },
): Promise<ScanOutResult[]> {
  const left = new Map(ctx.allowed);
  const out: ScanOutResult[] = [];
  for (const epc of epcs) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cur = await client.query<ItemRow>(`${ITEM_SQL} WHERE i.epc = $1 FOR UPDATE OF i`, [epc]);
      const row = cur.rows[0];
      const item = row ? toItem(row) : ({ epc, status: null, serial: null, customSkuId: null, sku: null, upc: null, name: null, color: null, size: null, bin: null } as ScanOutItem);
      const rssi = ctx.rssi?.[epc] ?? null;
      const room = row?.custom_sku_id ? left.get(row.custom_sku_id) ?? 0 : 0;
      const error = !row
        ? "This tag is not in the WMS."
        : !(SCAN_IN_FROM as readonly string[]).includes(row.status)
          ? `This tag is ${row.status === "in-stock" ? "already LIVE" : row.status.toUpperCase()} — only IN TRANSIT, SOLD, UNKNOWN or RETURN pieces come back in.`
          : !left.has(row.custom_sku_id ?? "")
            ? "This item is not on this return."
            : room <= 0
              ? "All of this item on the return is already scanned in."
              : null;
      if (error) {
        await logEvent(client, who, "rejected", item, { ...ctx, oldStatus: row?.status ?? null, newStatus: null, rssi, detail: error });
        await client.query("COMMIT");
        out.push({ ...item, ok: false, oldStatus: row?.status ?? null, error });
        continue;
      }
      await client.query(`UPDATE items SET status = 'in-stock', last_seen_at = now() WHERE epc = $1`, [epc]);
      await client.query(
        `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
         VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, $3, 'in-stock', $4, NULL, $5::uuid, $6)`,
        [who.tenantId, epc, row!.status, `scan_in ${ctx.returnName ?? ctx.orderName ?? ""}`.trim(), who.userId, ctx.reader ?? null],
      );
      await logEvent(client, who, "scan_in", item, { ...ctx, oldStatus: row!.status, newStatus: "in-stock", rssi });
      await client.query("COMMIT");
      left.set(row!.custom_sku_id!, room - 1);
      out.push({ ...item, status: "in-stock", ok: true, oldStatus: row!.status });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      out.push({ epc, status: null, serial: null, customSkuId: null, sku: null, upc: null, name: null, color: null, size: null, bin: null, ok: false, oldStatus: null, error: e instanceof Error ? e.message : "Database error" });
    } finally {
      client.release();
    }
  }
  return out;
}

/**
 * Undo a scan-out: the tag goes back to what it was before — LIVE almost
 * always; UNKNOWN when it was the placeholder an online order had marked, so
 * the order's piece is not counted twice. A held tag the scan-out released
 * goes back to UNKNOWN. Only the latest scan-out of a tag
 * that is still SOLD can be undone; the undo is logged as its own action.
 */
export async function undoScanOut(pool: Pool, who: Who, epc: string, ctx: OrderRef): Promise<ScanOutResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<ItemRow>(`${ITEM_SQL} WHERE i.epc = $1 FOR UPDATE OF i`, [epc]);
    const row = cur.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return { epc, status: null, serial: null, customSkuId: null, sku: null, upc: null, name: null, color: null, size: null, bin: null, ok: false, oldStatus: null, error: "This tag is not in the WMS." };
    }
    const item = toItem(row);
    const last = await client.query<{ action: string; old_status: string | null; detail: string | null }>(
      `SELECT action, old_status, detail FROM scan_out_events
        WHERE tenant_id = $1::uuid AND epc = $2 AND action IN ('scan_out', 'scan_in', 'undo')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [who.tenantId, epc],
    );
    const ev = last.rows[0];
    // The latest scan of this tag, still in the state it left it in: SOLD after a scan-out, LIVE after a scan-in.
    const expect = ev?.action === "scan_out" ? "sold" : ev?.action === "scan_in" ? "in-stock" : null;
    if (!ev || !expect || row.status !== expect) {
      await client.query("ROLLBACK");
      return { ...item, ok: false, oldStatus: row.status, error: !expect ? "This tag was not scanned here, so it cannot be undone here." : `This tag is ${row.status === "in-stock" ? "LIVE" : row.status.toUpperCase()} now — nothing to undo.` };
    }
    // After a scan-out: back to what it was (UNKNOWN stays UNKNOWN). After a scan-in: back to what it was.
    const back = ev.action === "scan_out" ? (ev.old_status === "unknown" ? "unknown" : "in-stock") : (ev.old_status ?? "sold");
    await client.query(`UPDATE items SET status = $2 WHERE epc = $1`, [epc, back]);
    await client.query(
      `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
       VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, $3, $4, $5, NULL, $6::uuid, NULL)`,
      [who.tenantId, epc, expect, back, `${ev.action}_undo ${ctx.returnName ?? ctx.orderName ?? ""}`.trim(), who.userId],
    );
    // The scan-out released a held tag back to LIVE — hold it again while it is still LIVE.
    let detail: string | null = null;
    const released = ev.action === "scan_out" ? ev.detail?.match(/Held tag ([0-9A-F]{24}) back to LIVE/)?.[1] : undefined;
    if (released) {
      const re = await client.query(`UPDATE items SET status = 'unknown' WHERE epc = $1 AND status = 'in-stock' RETURNING epc`, [released]);
      if (re.rowCount) {
        await client.query(
          `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
           VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, 'in-stock', 'unknown', $3, NULL, $4::uuid, NULL)`,
          [who.tenantId, released, `scan_out_undo ${ctx.returnName ?? ctx.orderName ?? ""} (held again)`.trim(), who.userId],
        );
        detail = `Held tag ${released} UNKNOWN again`;
      }
    }
    await logEvent(client, who, "undo", item, { ...ctx, oldStatus: expect, newStatus: back, detail });
    await client.query("COMMIT");
    return { ...item, status: back, ok: true, oldStatus: expect };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return { epc, status: null, serial: null, customSkuId: null, sku: null, upc: null, name: null, color: null, size: null, bin: null, ok: false, oldStatus: null, error: e instanceof Error ? e.message : "Database error" };
  } finally {
    client.release();
  }
}

/* ─────────────────────────────── the report ─────────────────────────────── */

export type ScanOutEventRow = {
  id: string;
  at: string;
  user: string;
  action: string;
  epc: string | null;
  oldStatus: string | null;
  newStatus: string | null;
  sku: string | null;
  upc: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  bin: string | null;
  orderName: string | null;
  returnName: string | null;
  reader: string | null;
  rssi: number | null;
  detail: string | null;
};

export async function listScanOutEvents(pool: Pool, tenantId: string, opts: { search?: string; limit?: number } = {}): Promise<ScanOutEventRow[]> {
  const params: unknown[] = [tenantId];
  let where = "e.tenant_id = $1::uuid";
  const s = opts.search?.trim();
  if (s) {
    params.push(`%${s}%`);
    where += ` AND (e.epc ILIKE $2 OR e.sku ILIKE $2 OR e.upc ILIKE $2 OR e.item_name ILIKE $2 OR e.order_name ILIKE $2 OR e.return_name ILIKE $2 OR u.email ILIKE $2 OR u.first_name ILIKE $2 OR u.last_name ILIKE $2)`;
  }
  params.push(Math.min(opts.limit ?? 500, 2000));
  const r = await pool.query<{
    id: string; created_at: Date; action: string; epc: string | null; old_status: string | null; new_status: string | null;
    sku: string | null; upc: string | null; item_name: string | null; color: string | null; size: string | null; bin: string | null;
    order_name: string | null; return_name: string | null; reader: string | null; rssi: number | null; detail: string | null;
    first_name: string | null; last_name: string | null; email: string | null;
  }>(
    `SELECT e.id::text, e.created_at, e.action, e.epc, e.old_status, e.new_status, e.sku, e.upc, e.item_name, e.color, e.size,
            e.bin, e.order_name, e.return_name, e.reader, e.rssi, e.detail, u.first_name, u.last_name, u.email
       FROM scan_out_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE ${where}
      ORDER BY e.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((x) => ({
    id: x.id,
    at: x.created_at.toISOString(),
    user: shortName(x.first_name, x.last_name, x.email), // "First L." — the locked rule, never the raw email
    action: x.action,
    epc: x.epc,
    oldStatus: x.old_status,
    newStatus: x.new_status,
    sku: x.sku,
    upc: x.upc,
    name: x.item_name,
    color: x.color,
    size: x.size,
    bin: x.bin,
    orderName: x.order_name,
    returnName: x.return_name,
    reader: x.reader,
    rssi: x.rssi,
    detail: x.detail,
  }));
}
