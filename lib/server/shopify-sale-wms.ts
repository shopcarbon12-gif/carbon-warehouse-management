/**
 * The WMS side of a Shopify order: for each line, the item in the WMS (UPC,
 * bin, colour, size) and the exact tags the orders/paid webhook marked
 * `unknown` for it, with their status now. The webhook records those EPCs in
 * shopify_sale_events.detail (app/api/webhooks/shopify/orders-paid).
 */
import type { Pool } from "pg";
import { lookupItems, type ScanOutItem } from "@/lib/server/scan-out";

export type SaleLineWms = {
  sku: string | null;
  customSkuId: string | null;
  upc: string | null;
  bin: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
  /** Tags this order marked unknown, with their status now. */
  marked: ScanOutItem[];
};

export async function saleWms(
  pool: Pool,
  orderId: string,
  lines: Array<{ sku: string | null; variantId: string | null }>,
): Promise<{ processed: boolean; lines: SaleLineWms[] }> {
  const ev = await pool.query<{ detail: Array<{ sku?: string; epcs?: string[] }> | null }>(
    `SELECT detail FROM shopify_sale_events WHERE order_id = $1`,
    [orderId],
  );
  const detail = ev.rows[0]?.detail ?? [];
  // A SKU can appear on two lines; each line takes the next unclaimed entry.
  const pool2 = detail.map((d) => ({ sku: String(d.sku ?? ""), epcs: Array.isArray(d.epcs) ? d.epcs : [], used: false }));

  const out: SaleLineWms[] = [];
  for (const l of lines) {
    const sku = (l.sku ?? "").trim();
    const cs = await pool.query<{ id: string; upc: string | null; name: string | null; color: string | null; size: string | null; bin: string | null }>(
      `SELECT cs.id::text, COALESCE(NULLIF(cs.upc, ''), m.upc) AS upc, m.description AS name, cs.color_code AS color, cs.size,
              COALESCE(
                (SELECT b2.code FROM items i2 JOIN bins b2 ON b2.id = i2.bin_id
                  WHERE i2.custom_sku_id = cs.id AND i2.status = 'in-stock' AND b2.archived_at IS NULL
                  GROUP BY b2.code ORDER BY count(*) DESC, b2.code LIMIT 1),
                (SELECT b3.code FROM bins b3 WHERE b3.id = cs.assigned_bin_id AND b3.archived_at IS NULL)
              ) AS bin
         FROM custom_skus cs JOIN matrices m ON m.id = cs.matrix_id
        WHERE cs.archived = FALSE AND (($2 <> '' AND cs.shopify_variant_id = $2) OR ($1 <> '' AND cs.sku = $1))
        ORDER BY (cs.shopify_variant_id = $2) DESC NULLS LAST
        LIMIT 1`,
      [sku, l.variantId ?? ""],
    );
    const entry = pool2.find((d) => !d.used && d.sku === sku);
    if (entry) entry.used = true;
    const marked = entry ? await lookupItems(pool, entry.epcs) : [];
    const row = cs.rows[0];
    out.push({
      sku: sku || null,
      customSkuId: row?.id ?? null,
      upc: row?.upc ?? null,
      bin: row?.bin ?? null,
      name: row?.name ?? null,
      color: row?.color ?? null,
      size: row?.size ?? null,
      marked,
    });
  }
  return { processed: ev.rowCount !== 0, lines: out };
}
