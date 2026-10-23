import type { Pool } from "pg";
import { shortStaffName } from "@/lib/staff-name";

/**
 * Store Replenishment — the handheld's Find & Locate module that turns POS
 * sales into a pick list for refilling the showroom from the back.
 *
 *  - Sales: completed sales of the POS store whose WMS location is the
 *    handheld's location (Orlando → the showroom, POS store 01). Refunded and
 *    voided sales are hidden. "Sold" = quantity on product lines (misc charges
 *    are not items).
 *  - Stock: LIVE (in-stock) tags of that SKU at the same WMS location.
 *  - Pick: one checkbox per sale line; only lines with stock can be picked.
 *    Picking never touches stock — it only records "found and pulled".
 *  - A sale is complete (green) when every line that has stock is picked.
 */

export type ReplenishmentSale = {
  id: number;
  saleNumber: string;
  createdAt: string;
  /** In the STORE's time zone (Orlando), so a phone with a wrong clock zone
   *  still shows the right time: "2026-10-12", "MON OCT 12, 2026", "3:58 PM". */
  localDate: string;
  localDay: string;
  localTime: string;
  employee: string | null;
  customer: string | null;
  soldQty: number;
  pickableLines: number;
  pickedLines: number;
  complete: boolean;
};

export type ReplenishmentLine = {
  lineId: number;
  customSkuId: string | null;
  sku: string | null;
  name: string;
  color: string | null;
  size: string | null;
  upc: string | null;
  retailPrice: number | null;
  bin: string | null;
  soldQty: number;
  inStock: number;
  pickable: boolean;
  picked: boolean;
  pickedBy: string | null;
  pickedAt: string | null;
  /** Units (EPCs) pulled for this line via "Find any unit" — see pickUnit. */
  pickedUnits: number;
  /** LIVE tags of this size already in the "Store" zone — the phone's store icon. */
  storeZoneCount: number;
};

const SALE_LINE_FACTS = `
  SELECT l.id AS line_id, l.sale_id, l.sku_id, l.quantity, l.description,
         (SELECT count(*)::int FROM items i
           WHERE i.custom_sku_id = l.sku_id AND i.location_id = $LID::uuid AND i.status = 'in-stock') AS in_stock,
         p.sale_line_id IS NOT NULL AS picked, p.picked_by_name, p.picked_at
    FROM pos_sale_lines l
    LEFT JOIN store_replenishment_picks p ON p.sale_line_id = l.id
   WHERE coalesce(l.line_type, 'product') = 'product' AND l.quantity > 0`;

/**
 * `range`: store-local calendar days (fromDate/toDate, YYYY-MM-DD, inclusive;
 * both omitted = TODAY in the store's time zone), or — for 1.2.163 handhelds —
 * instants (from/to). `saleId` narrows to one sale.
 */
export async function listReplenishmentSales(
  pool: Pool,
  locationId: string,
  range: { from?: string | null; to?: string | null; fromDate?: string | null; toDate?: string | null; saleId?: number },
): Promise<ReplenishmentSale[]> {
  const byInstant = !!(range.from || range.to);
  const r = await pool.query<{
    id: number;
    sale_number: string;
    created_at: Date;
    local_date: string;
    local_day: string;
    local_time: string;
    employee: string | null;
    customer: string | null;
    sold_qty: number;
    pickable_lines: number;
    picked_lines: number;
  }>(
    `WITH facts AS (${SALE_LINE_FACTS.replace(/\$LID/g, "$1")})
     SELECT s.id, s.sale_number, s.created_at,
            to_char(s.created_at AT TIME ZONE pl.timezone, 'YYYY-MM-DD') AS local_date,
            upper(to_char(s.created_at AT TIME ZONE pl.timezone, 'Dy Mon FMDD, YYYY')) AS local_day,
            to_char(s.created_at AT TIME ZONE pl.timezone, 'FMHH12:MI AM') AS local_time,
            nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS employee,
            nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') AS customer,
            coalesce(sum(f.quantity), 0)::int AS sold_qty,
            count(*) FILTER (WHERE f.sku_id IS NOT NULL AND f.in_stock > 0)::int AS pickable_lines,
            count(*) FILTER (WHERE f.sku_id IS NOT NULL AND f.in_stock > 0 AND f.picked)::int AS picked_lines
       FROM pos_sales s
       JOIN pos_locations pl ON pl.id = s.pos_location_id AND pl.wms_location_id = $1::uuid
       LEFT JOIN pos_employees e ON e.id = coalesce(s.attributed_employee_id, s.cashier_id)
       LEFT JOIN users u ON u.id = e.user_id
       LEFT JOIN pos_customers c ON c.id = s.customer_id
       LEFT JOIN facts f ON f.sale_id = s.id
      WHERE s.status = 'completed' AND s.voided_at IS NULL
        AND ($4::int IS NOT NULL OR (
              CASE WHEN $5::boolean
                THEN s.created_at >= coalesce($2::timestamptz, '-infinity') AND s.created_at < coalesce($3::timestamptz, 'infinity')
                ELSE (s.created_at AT TIME ZONE pl.timezone)::date
                       BETWEEN coalesce($6::date, (now() AT TIME ZONE pl.timezone)::date)
                           AND coalesce($7::date, $6::date, (now() AT TIME ZONE pl.timezone)::date)
              END))
        AND ($4::int IS NULL OR s.id = $4::int)
      GROUP BY s.id, pl.timezone, u.first_name, u.last_name, c.first_name, c.last_name
     HAVING coalesce(sum(f.quantity), 0) > 0 -- misc-charge-only sales have nothing to pick
      ORDER BY s.created_at DESC
      LIMIT 500`,
    [
      locationId,
      range.from ?? null,
      range.to ?? null,
      range.saleId ?? null,
      byInstant,
      range.fromDate ?? null,
      range.toDate ?? null,
    ],
  );
  return r.rows.map((x) => ({
    id: x.id,
    saleNumber: x.sale_number,
    createdAt: x.created_at.toISOString(),
    localDate: x.local_date,
    localDay: x.local_day,
    localTime: x.local_time,
    employee: shortStaffName(x.employee) ?? null, // "First L." — not a report
    customer: x.customer,
    soldQty: x.sold_qty,
    pickableLines: x.pickable_lines,
    pickedLines: x.picked_lines,
    complete: x.pickable_lines > 0 && x.picked_lines === x.pickable_lines,
  }));
}

export async function getReplenishmentLines(
  pool: Pool,
  locationId: string,
  saleId: number,
): Promise<{ sale: ReplenishmentSale | null; lines: ReplenishmentLine[] }> {
  const [sale] = await listReplenishmentSales(pool, locationId, { saleId });
  if (!sale) return { sale: null, lines: [] };

  const r = await pool.query<{
    line_id: number;
    sku_id: string | null;
    quantity: number;
    description: string | null;
    in_stock: number;
    picked: boolean;
    picked_by_name: string | null;
    picked_at: Date | null;
    sku: string | null;
    name: string | null;
    color: string | null;
    size: string | null;
    upc: string | null;
    retail_price: string | null;
    bin: string | null;
    picked_units: number;
    store_zone_count: number;
  }>(
    `WITH facts AS (${SALE_LINE_FACTS.replace(/\$LID/g, "$1")} AND l.sale_id = $2)
     SELECT f.*, cs.sku, m.description AS name, cs.color_code AS color, cs.size,
            (SELECT count(*)::int FROM store_replenishment_units u WHERE u.sale_line_id = f.line_id) AS picked_units,
            (SELECT count(*)::int FROM items i
               JOIN assigned_zones az ON az.id = i.assigned_zone_id AND az.archived_at IS NULL
              WHERE i.custom_sku_id = f.sku_id AND i.location_id = $1::uuid AND i.status = 'in-stock'
                AND lower(btrim(az.name)) = 'store') AS store_zone_count,
            coalesce(cs.upc, m.upc) AS upc, cs.retail_price::text AS retail_price,
            coalesce(
              (SELECT b.code FROM items i JOIN bins b ON b.id = i.bin_id
                WHERE i.custom_sku_id = f.sku_id AND i.location_id = $1::uuid AND i.status = 'in-stock'
                GROUP BY b.code ORDER BY count(*) DESC, b.code LIMIT 1),
              ab.code
            ) AS bin
       FROM facts f
       LEFT JOIN custom_skus cs ON cs.id = f.sku_id
       LEFT JOIN matrices m ON m.id = cs.matrix_id
       -- Home bin fallback: only a live bin of this location.
       LEFT JOIN bins ab ON ab.id = cs.assigned_bin_id AND ab.location_id = $1::uuid AND ab.archived_at IS NULL
      -- Pick order: lines with stock first, then by bin (walk the aisles in
      -- order; no bin last), then by product name.
      ORDER BY (f.sku_id IS NOT NULL AND f.in_stock > 0) DESC, bin NULLS LAST, name NULLS LAST, f.line_id`,
    [locationId, saleId],
  );
  return {
    sale,
    lines: r.rows.map((x) => ({
      lineId: x.line_id,
      customSkuId: x.sku_id,
      sku: x.sku,
      name: x.name || x.description || "Item",
      color: x.color,
      size: x.size,
      upc: x.upc,
      retailPrice: x.retail_price === null ? null : Number(x.retail_price),
      bin: x.bin,
      soldQty: x.quantity,
      inStock: x.in_stock,
      pickable: !!x.sku_id && x.in_stock > 0,
      picked: x.picked,
      pickedBy: shortStaffName(x.picked_by_name) ?? null, // stored full; shown "First L."
      pickedAt: x.picked_at ? x.picked_at.toISOString() : null,
      pickedUnits: x.picked_units,
      storeZoneCount: x.store_zone_count,
    })),
  };
}

/** Tick / untick one sale line. Only lines of this location's sales that have stock. */
export async function setLinePicked(
  pool: Pool,
  locationId: string,
  lineId: number,
  picked: boolean,
  by: { userId: string; name: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const r = await pool.query<{ sale_id: number; sku_id: string | null; in_stock: number }>(
    `SELECT l.sale_id, l.sku_id,
            (SELECT count(*)::int FROM items i
              WHERE i.custom_sku_id = l.sku_id AND i.location_id = $1::uuid AND i.status = 'in-stock') AS in_stock
       FROM pos_sale_lines l
       JOIN pos_sales s ON s.id = l.sale_id AND s.status = 'completed' AND s.voided_at IS NULL
       JOIN pos_locations pl ON pl.id = s.pos_location_id AND pl.wms_location_id = $1::uuid
      WHERE l.id = $2 AND coalesce(l.line_type, 'product') = 'product'`,
    [locationId, lineId],
  );
  const line = r.rows[0];
  if (!line) return { ok: false, error: "Line not found" };
  if (!picked) {
    await pool.query(`DELETE FROM store_replenishment_picks WHERE sale_line_id = $1`, [lineId]);
    return { ok: true };
  }
  if (!line.sku_id || line.in_stock <= 0) return { ok: false, error: "This item has no stock to pick" };
  await pool.query(
    `INSERT INTO store_replenishment_picks (sale_line_id, sale_id, picked_by, picked_by_name)
     VALUES ($1, $2, $3, $4) ON CONFLICT (sale_line_id) DO NOTHING`,
    [lineId, line.sale_id, by.userId, by.name],
  );
  return { ok: true };
}

// ── Per-unit picking (Locate 2.0 stage D) ───────────────────────────────────

type LineOwner = { sale_id: number; sku_id: string | null; quantity: number };

async function lineAtLocation(
  q: Pick<Pool, "query">,
  locationId: string,
  lineId: number,
): Promise<LineOwner | null> {
  const r = await q.query<LineOwner>(
    `SELECT l.sale_id, l.sku_id, l.quantity
       FROM pos_sale_lines l
       JOIN pos_sales s ON s.id = l.sale_id AND s.status = 'completed' AND s.voided_at IS NULL
       JOIN pos_locations pl ON pl.id = s.pos_location_id AND pl.wms_location_id = $1::uuid
      WHERE l.id = $2 AND coalesce(l.line_type, 'product') = 'product'`,
    [locationId, lineId],
  );
  return r.rows[0] ?? null;
}

export type EligibleUnits = {
  lineId: number;
  customSkuId: string;
  sku: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  retailPrice: number | null;
  required: number;
  pickedUnits: number;
  pickedEpcs: string[];
  /** LIVE units of the exact SKU at this location not already pulled for any line. */
  candidates: { epc: string; bin: string | null }[];
  checkedAt: string;
};

/** What "Find any unit" may search for on one sale line. */
export async function getEligibleUnits(
  pool: Pool,
  locationId: string,
  lineId: number,
): Promise<EligibleUnits | null> {
  const line = await lineAtLocation(pool, locationId, lineId);
  if (!line || !line.sku_id) return null;
  const [info, picked, cands] = await Promise.all([
    pool.query<{ sku: string | null; name: string | null; color: string | null; size: string | null; retail_price: string | null }>(
      `SELECT cs.sku, m.description AS name, cs.color_code AS color, cs.size, cs.retail_price::text
         FROM custom_skus cs LEFT JOIN matrices m ON m.id = cs.matrix_id WHERE cs.id = $1::uuid`,
      [line.sku_id],
    ),
    pool.query<{ epc: string }>(`SELECT epc FROM store_replenishment_units WHERE sale_line_id = $1 ORDER BY picked_at`, [lineId]),
    pool.query<{ epc: string; bin: string | null }>(
      `SELECT i.epc, b.code AS bin
         FROM items i
         LEFT JOIN bins b ON b.id = i.bin_id
        WHERE i.custom_sku_id = $1::uuid AND i.location_id = $2::uuid AND i.status = 'in-stock'
          AND NOT EXISTS (SELECT 1 FROM store_replenishment_units u WHERE u.epc = i.epc)
        ORDER BY b.code NULLS LAST, i.epc
        LIMIT 500`,
      [line.sku_id, locationId],
    ),
  ]);
  const x = info.rows[0];
  return {
    lineId,
    customSkuId: line.sku_id,
    sku: x?.sku ?? null,
    name: x?.name ?? null,
    color: x?.color ?? null,
    size: x?.size ?? null,
    retailPrice: x?.retail_price == null ? null : Number(x.retail_price),
    required: line.quantity,
    pickedUnits: picked.rowCount ?? 0,
    pickedEpcs: picked.rows.map((p) => p.epc),
    candidates: cands.rows,
    checkedAt: new Date().toISOString(),
  };
}

export type UnitPickResult =
  | { ok: true; pickedUnits: number; required: number; linePicked: boolean }
  | { ok: false; error: string; status: number };

/**
 * Record one physically pulled unit for a line. Re-validates at the moment of
 * the pick: the line is this location's completed sale, the EPC is LIVE here
 * and is the line's exact SKU (colour + size), and no line/operator already
 * counted it (UNIQUE epc). Reaching the sold quantity completes the line.
 * Stock is not changed.
 */
export async function pickUnit(
  pool: Pool,
  locationId: string,
  lineId: number,
  epcRaw: string,
  by: { userId: string; name: string | null; method: string | null },
): Promise<UnitPickResult> {
  const epc = epcRaw.trim().toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(epc)) return { ok: false, error: "Not a valid EPC", status: 400 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('repl-line:' || $1))", [String(lineId)]);
    const line = await lineAtLocation(client, locationId, lineId);
    if (!line || !line.sku_id) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Line not found", status: 404 };
    }
    const item = await client.query<{ custom_sku_id: string | null; status: string }>(
      `SELECT custom_sku_id::text, status FROM items WHERE epc = $1 AND location_id = $2::uuid`,
      [epc, locationId],
    );
    const it = item.rows[0];
    if (!it) {
      await client.query("ROLLBACK");
      return { ok: false, error: "This tag is not at this location", status: 409 };
    }
    if (it.custom_sku_id !== line.sku_id) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Wrong item — this tag is a different SKU / colour / size", status: 409 };
    }
    if (it.status !== "in-stock") {
      await client.query("ROLLBACK");
      return { ok: false, error: `This tag is not live (${it.status})`, status: 409 };
    }
    const ins = await client.query(
      `INSERT INTO store_replenishment_units (sale_line_id, sale_id, epc, custom_sku_id, picked_by, picked_by_name, method)
       VALUES ($1, $2, $3, $4::uuid, $5, $6, $7) ON CONFLICT (epc) DO NOTHING`,
      [lineId, line.sale_id, epc, line.sku_id, by.userId, by.name, by.method],
    );
    if (!ins.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, error: "This unit was already pulled", status: 409 };
    }
    const n = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM store_replenishment_units WHERE sale_line_id = $1`,
      [lineId],
    );
    const picked = n.rows[0]?.n ?? 0;
    const done = picked >= line.quantity;
    if (done) {
      await client.query(
        `INSERT INTO store_replenishment_picks (sale_line_id, sale_id, picked_by, picked_by_name, source)
         VALUES ($1, $2, $3, $4, 'units') ON CONFLICT (sale_line_id) DO NOTHING`,
        [lineId, line.sale_id, by.userId, by.name],
      );
    }
    await client.query("COMMIT");
    return { ok: true, pickedUnits: picked, required: line.quantity, linePicked: done };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Undo one pulled unit; reopens the line only if the units had completed it. */
export async function unpickUnit(
  pool: Pool,
  locationId: string,
  lineId: number,
  epcRaw: string,
): Promise<UnitPickResult> {
  const epc = epcRaw.trim().toUpperCase();
  const line = await lineAtLocation(pool, locationId, lineId);
  if (!line) return { ok: false, error: "Line not found", status: 404 };
  await pool.query(`DELETE FROM store_replenishment_units WHERE sale_line_id = $1 AND epc = $2`, [lineId, epc]);
  const n = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM store_replenishment_units WHERE sale_line_id = $1`,
    [lineId],
  );
  const picked = n.rows[0]?.n ?? 0;
  if (picked < line.quantity) {
    await pool.query(`DELETE FROM store_replenishment_picks WHERE sale_line_id = $1 AND source = 'units'`, [lineId]);
  }
  const still = await pool.query(`SELECT 1 FROM store_replenishment_picks WHERE sale_line_id = $1`, [lineId]);
  return { ok: true, pickedUnits: picked, required: line.quantity, linePicked: (still.rowCount ?? 0) > 0 };
}
