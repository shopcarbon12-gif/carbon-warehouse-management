import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sales for one catalog item (custom_sku). Reads the Carbon-POS tables in the
 * shared DB (pos_sales / pos_sale_lines / pos_locations / pos_customers) where
 * pos_sale_lines.sku_id = the custom_sku id. One row per sale, aggregating this
 * item's lines in that sale; sale-level subtotal/discount/tax/total come from
 * pos_sales. Cost/profit/margin use the WMS catalog cost (custom_skus.default_cost
 * × qty) since POS lines don't store cost.
 *
 * Powers both the item popup's Sales tab and Customers tab (the client groups
 * by customer for the latter).
 *
 * Query: from, to (YYYY-MM-DD), locationId (wms uuid), saleId (substring),
 *        customer (name substring).
 * Also returns `locations` (WMS locations that have a mapped POS location) for
 * the location filter, and `storeCodeById` so the client can build POS links
 * /sales/{storeCode3}/{saleId}.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid custom_sku id" }, { status: 400 });
  }

  const url = new URL(req.url);
  const from = (url.searchParams.get("from") || "1900-01-01").slice(0, 10);
  const to = (url.searchParams.get("to") || "2038-01-01").slice(0, 10);
  const locationId = url.searchParams.get("locationId")?.trim() || "";
  const saleId = url.searchParams.get("saleId")?.trim() || "";
  const customer = url.searchParams.get("customer")?.trim() || "";

  const cost = await pool.query<{ default_cost: string | null }>(
    `SELECT default_cost::text FROM custom_skus WHERE id = $1::uuid`,
    [id],
  );
  const unitCost = Number.parseFloat(cost.rows[0]?.default_cost ?? "") || 0;

  const vals: unknown[] = [id, from, to];
  let where = `sl.sku_id = $1::uuid
       AND COALESCE(s.completed_at, s.created_at) >= $2::date
       AND COALESCE(s.completed_at, s.created_at) < ($3::date + INTERVAL '1 day')`;
  if (locationId && UUID_RE.test(locationId)) {
    vals.push(locationId);
    where += ` AND l.wms_location_id = $${vals.length}::uuid`;
  }
  if (saleId) {
    vals.push(`%${saleId}%`);
    where += ` AND (s.sale_number ILIKE $${vals.length} OR s.id::text ILIKE $${vals.length})`;
  }
  if (customer) {
    vals.push(`%${customer}%`);
    where += ` AND (COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) ILIKE $${vals.length}`;
  }

  const r = await pool.query<{
    sale_id: number;
    sale_number: string | null;
    store_code: string | null;
    date: string;
    status: string | null;
    sale_subtotal: string | null;
    sale_discount: string | null;
    sale_tax: string | null;
    sale_total: string | null;
    customer_id: number | null;
    customer_name: string | null;
    item_qty: string | null;
    item_unit_price: string | null;
    item_revenue: string | null;
    item_discount: string | null;
    item_tax: string | null;
  }>(
    `SELECT
       s.id                                   AS sale_id,
       s.sale_number                          AS sale_number,
       l.store_code                           AS store_code,
       COALESCE(s.completed_at, s.created_at) AS date,
       s.status                               AS status,
       s.subtotal::text                       AS sale_subtotal,
       s.discount_amount::text                AS sale_discount,
       s.tax_amount::text                     AS sale_tax,
       s.total_amount::text                   AS sale_total,
       c.id                                   AS customer_id,
       NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS customer_name,
       SUM(sl.quantity)::text                 AS item_qty,
       MAX(sl.unit_price)::text               AS item_unit_price,
       SUM(sl.line_total)::text               AS item_revenue,
       SUM(sl.discount_amount)::text          AS item_discount,
       SUM(sl.tax_amount)::text               AS item_tax
     FROM pos_sale_lines sl
     JOIN pos_sales s ON s.id = sl.sale_id
     LEFT JOIN pos_locations l ON l.id = s.pos_location_id
     LEFT JOIN pos_customers c ON c.id = s.customer_id
     WHERE ${where}
     GROUP BY s.id, s.sale_number, l.store_code, s.status,
              s.subtotal, s.discount_amount, s.tax_amount, s.total_amount, c.id,
              c.first_name, c.last_name
     ORDER BY COALESCE(s.completed_at, s.created_at) DESC, s.id DESC
     LIMIT 500`,
    vals,
  );

  const num = (s: string | null) => Number.parseFloat(s ?? "") || 0;
  const rows = r.rows.map((row) => {
    const qty = num(row.item_qty);
    const revenue = num(row.item_revenue);
    const lineCost = unitCost * qty;
    const profit = revenue - lineCost;
    const margin = revenue !== 0 ? (profit / revenue) * 100 : null;
    return {
      sale_id: row.sale_id,
      sale_number: row.sale_number,
      store_code: row.store_code,
      date: row.date,
      status: row.status,
      sale_subtotal: num(row.sale_subtotal),
      sale_discount: num(row.sale_discount),
      sale_tax: num(row.sale_tax),
      sale_total: num(row.sale_total),
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      qty,
      unit_price: num(row.item_unit_price),
      revenue,
      item_discount: num(row.item_discount),
      item_tax: num(row.item_tax),
      cost: lineCost,
      profit,
      margin,
    };
  });

  // WMS locations that have a mapped POS location — for the location filter.
  const locs = await pool.query<{ id: string; code: string; name: string }>(
    `SELECT DISTINCT wl.id::text AS id, wl.code, wl.name
       FROM pos_locations pl
       JOIN locations wl ON wl.id = pl.wms_location_id
      WHERE wl.tenant_id = $1::uuid
      ORDER BY wl.code`,
    [session.tid],
  );

  return NextResponse.json(
    {
      rows,
      unit_cost: unitCost,
      locations: locs.rows,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
