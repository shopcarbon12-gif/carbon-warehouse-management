import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inventory movement log for one catalog item (custom_sku) — the History tab.
 *
 * Unions the movement sources the WMS can see for this item, newest first:
 *   1. Carbon-POS sales (pos_sale_lines.sku_id) → reason "Sold", Δqty negative,
 *      Δvalue = -revenue, source "Sale #<n>", customer, POS sale link bits.
 *   2. manual_item_qty_history → manual adjustments / transfers / count
 *      reconciliations with the recorded reason + who + delta.
 *
 * Not yet included (future): POS refunds and per-EPC events. Δnegative /
 * Δreserved / Δavg-cost are Lightspeed concepts the WMS doesn't track — the UI
 * shows "—" for those columns.
 *
 * Query: from, to (YYYY-MM-DD).
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

  const r = await pool.query<{
    id: string;
    at: string;
    employee: string | null;
    reason: string | null;
    delta_qty: string | null;
    delta_value: string | null;
    source: string | null;
    customer: string | null;
    sale_id: string | null;
    store_code: string | null;
  }>(
    `(
       SELECT
         'sale-' || s.id::text                  AS id,
         COALESCE(s.completed_at, s.created_at)  AS at,
         'Carbon POS'                            AS employee,
         'Sold'                                  AS reason,
         (-SUM(sl.quantity))::numeric            AS delta_qty,
         (-SUM(sl.line_total))::numeric          AS delta_value,
         'Sale #' || COALESCE(s.sale_number, s.id::text) AS source,
         NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS customer,
         s.id::text                              AS sale_id,
         l.store_code                            AS store_code
       FROM pos_sale_lines sl
       JOIN pos_sales s ON s.id = sl.sale_id
       LEFT JOIN pos_locations l ON l.id = s.pos_location_id
       LEFT JOIN pos_customers c ON c.id = s.customer_id
       WHERE sl.sku_id = $1::uuid
         AND COALESCE(s.completed_at, s.created_at) >= $2::date
         AND COALESCE(s.completed_at, s.created_at) < ($3::date + INTERVAL '1 day')
       GROUP BY s.id, s.sale_number, s.completed_at, s.created_at,
                c.first_name, c.last_name, l.store_code
     )
     UNION ALL
     (
       SELECT
         'mh-' || h.id::text                     AS id,
         h.changed_at                            AS at,
         h.changed_by_user_name                  AS employee,
         h.source                                AS reason,
         h.delta_qty::numeric                    AS delta_qty,
         NULL::numeric                           AS delta_value,
         COALESCE(h.transfer_slip_number, h.notes) AS source,
         NULL::text                              AS customer,
         NULL::text                              AS sale_id,
         NULL::text                              AS store_code
       FROM manual_item_qty_history h
       WHERE h.custom_sku_id = $1::uuid
         AND h.location_id = $4::uuid
         AND h.changed_at >= $2::date
         AND h.changed_at < ($3::date + INTERVAL '1 day')
     )
     ORDER BY at DESC
     LIMIT 500`,
    [id, from, to, session.lid],
  );

  const num = (s: string | null) => (s == null ? null : Number.parseFloat(s));
  const rows = r.rows.map((row) => ({
    id: row.id,
    at: row.at,
    employee: row.employee,
    reason: row.reason,
    delta_qty: num(row.delta_qty),
    delta_value: num(row.delta_value),
    source: row.source,
    customer: row.customer,
    sale_id: row.sale_id,
    store_code: row.store_code,
  }));

  return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
}
