import type { PoolClient } from "pg";

/**
 * Shopify refund → WMS qty reconciliation: the inverse of the orders/paid
 * webhook (app/api/webhooks/shopify/orders-paid).
 *
 * orders/paid flips the oldest N in-stock tags of each sold SKU to `unknown`
 * and records which ones in shopify_sale_events. When Shopify refunds the order
 * and restocks, this puts back exactly what that sale took:
 *
 *   • RFID   → the sale's recorded tags that are STILL `unknown` go back to
 *              `in-stock`, with an audit row each. A tag already `sold` was
 *              scanned out at shipping and is with the customer; it is left
 *              alone, and returns to in-stock by itself the next time the
 *              physical tag is scanned (the epc-ingress upsert — 0089 only
 *              blocks tag_killed / damaged / stolen from reviving).
 *   • Manual → manual_item_qty goes back up by the refunded quantity.
 *
 * Only restock types that put units back into inventory count. `no_restock`
 * means Shopify kept its quantity down, so the WMS keeps its down too.
 *
 * A refund never undoes more than its sale did: partial refunds of one order
 * are serialized on the sale row and each subtracts what earlier refunds
 * already restored. Orders the WMS never decremented (no sale event) are
 * skipped, because there is nothing to put back.
 *
 * Must run inside the caller's transaction.
 */

/** Shopify `restock_type` values that return units to stock. */
const RESTOCKING_TYPES = new Set(["cancel", "return", "legacy_restock"]);

export type ShopifyRefundPayload = {
  id?: number | string | null;
  order_id?: number | string | null;
  refund_line_items?: Array<{
    quantity?: number | null;
    restock_type?: string | null;
    line_item?: { sku?: string | null } | null;
  }> | null;
};

/** One entry of shopify_sale_events.detail, as written by orders/paid. */
type SaleDetailEntry = {
  sku?: string;
  qty?: number;
  kind?: "rfid" | "manual";
  epcs?: string[];
  /** Manual only: rows updated. 0 means no manual_item_qty row, so nothing was taken. */
  rows?: number;
};

type RefundDetailEntry = {
  sku: string;
  qty: number;
  kind?: "rfid" | "manual";
  restockType?: string;
  restored?: number;
  restoredEpcs?: string[];
  notRestored?: Array<{ epc: string; status: string | null }>;
  result?: string;
};

export type RefundSyncResult =
  | { duplicate: true }
  | { skipped: string }
  | { restoredInStock: number; manualIncremented: number };

export async function applyShopifyRefund(
  client: PoolClient,
  refund: ShopifyRefundPayload,
): Promise<RefundSyncResult> {
  const refundId = String(refund.id ?? "").trim();
  const orderId = String(refund.order_id ?? "").trim();
  if (!refundId || !orderId) return { skipped: "missing refund or order id" };

  const claim = await client.query(
    `INSERT INTO shopify_refund_events (refund_id, order_id)
       VALUES ($1, $2) ON CONFLICT (refund_id) DO NOTHING RETURNING refund_id`,
    [refundId, orderId],
  );
  if (claim.rowCount === 0) return { duplicate: true };

  const detail: RefundDetailEntry[] = [];
  const finish = async (restored: number, manualInc: number, orderName: string | null) => {
    await client.query(
      `UPDATE shopify_refund_events
          SET order_name = $2, restored_in_stock = $3, manual_incremented = $4, detail = $5::jsonb
        WHERE refund_id = $1`,
      [refundId, orderName, restored, manualInc, JSON.stringify(detail)],
    );
  };

  // Locking the sale row serializes concurrent partial refunds of one order,
  // so the "already restored" tally below cannot race.
  const sale = await client.query<{ order_name: string | null; detail: SaleDetailEntry[] | null }>(
    `SELECT order_name, detail FROM shopify_sale_events WHERE order_id = $1 FOR UPDATE`,
    [orderId],
  );
  if (sale.rowCount === 0) {
    detail.push({ sku: "", qty: 0, result: "no sale event — WMS never decremented this order" });
    await finish(0, 0, null);
    return { skipped: "no sale event" };
  }
  const orderName = sale.rows[0].order_name;

  // What the sale took, per SKU.
  const soldEpcs = new Map<string, string[]>();
  const soldManual = new Map<string, number>();
  for (const d of sale.rows[0].detail ?? []) {
    const sku = String(d.sku ?? "").trim();
    if (!sku) continue;
    if (d.kind === "rfid") soldEpcs.set(sku, [...(soldEpcs.get(sku) ?? []), ...(d.epcs ?? [])]);
    else if (d.kind === "manual" && (d.rows ?? 0) > 0) {
      soldManual.set(sku, (soldManual.get(sku) ?? 0) + Math.floor(Number(d.qty) || 0));
    }
  }

  // What earlier refunds of this order already put back.
  const prior = await client.query<{ detail: RefundDetailEntry[] | null }>(
    `SELECT detail FROM shopify_refund_events WHERE order_id = $1 AND refund_id <> $2`,
    [orderId, refundId],
  );
  const restoredBefore = new Set<string>();
  const manualBefore = new Map<string, number>();
  for (const row of prior.rows) {
    for (const d of row.detail ?? []) {
      for (const epc of d.restoredEpcs ?? []) restoredBefore.add(epc);
      if (d.kind === "manual") manualBefore.set(d.sku, (manualBefore.get(d.sku) ?? 0) + (d.restored ?? 0));
    }
  }

  // Refunded quantity per SKU, restocking lines only.
  const wanted = new Map<string, number>();
  for (const li of refund.refund_line_items ?? []) {
    const sku = String(li.line_item?.sku ?? "").trim();
    const qty = Math.floor(Number(li.quantity) || 0);
    const restockType = String(li.restock_type ?? "").trim();
    if (!sku || qty <= 0) continue;
    if (!RESTOCKING_TYPES.has(restockType)) {
      detail.push({ sku, qty, restockType, result: "not restocked in Shopify — left as is" });
      continue;
    }
    wanted.set(sku, (wanted.get(sku) ?? 0) + qty);
  }

  let restoredInStock = 0;
  let manualIncremented = 0;

  for (const [sku, qty] of wanted) {
    const epcs = soldEpcs.get(sku);
    if (epcs) {
      const candidates = epcs.filter((e) => !restoredBefore.has(e));
      const r = await client.query<{ epc: string; tenant_id: string | null }>(
        `UPDATE items i SET status = 'in-stock'
          WHERE i.id IN (
            SELECT id FROM items
             WHERE epc = ANY($1::text[]) AND status = 'unknown'
             ORDER BY array_position($1::text[], epc)
             LIMIT $2
             FOR UPDATE
          )
          RETURNING i.epc, (SELECT l.tenant_id::text FROM locations l WHERE l.id = i.location_id) AS tenant_id`,
        [candidates, qty],
      );
      for (const row of r.rows) {
        if (!row.tenant_id) continue;
        await client.query(
          `INSERT INTO inventory_audit_logs (
             tenant_id, log_type, entity_type, entity_reference, old_value, new_value,
             reason, user_id, user_uuid, device_id
           )
           VALUES ($1::uuid, 'STATUS_CHANGE', 'EPC', $2, 'unknown', 'in-stock', $3, NULL, NULL, NULL)`,
          [row.tenant_id, row.epc, `Shopify refund ${refundId} (order ${orderName ?? orderId})`],
        );
      }
      const restoredEpcs = r.rows.map((x) => x.epc);
      // When the refund came up short, name the sale's tags that were skipped
      // because they are no longer `unknown` (usually `sold` — shipped).
      const leftAlone =
        restoredEpcs.length < qty
          ? (
              await client.query<{ epc: string; status: string | null }>(
                `SELECT epc, status FROM items WHERE epc = ANY($1::text[]) AND status <> 'unknown'`,
                [candidates.filter((e) => !restoredEpcs.includes(e))],
              )
            ).rows
          : [];
      restoredInStock += restoredEpcs.length;
      detail.push({ sku, qty, kind: "rfid", restored: restoredEpcs.length, restoredEpcs, notRestored: leftAlone });
      continue;
    }

    const soldQty = soldManual.get(sku);
    if (soldQty !== undefined) {
      const n = Math.min(qty, Math.max(0, soldQty - (manualBefore.get(sku) ?? 0)));
      let rows = 0;
      if (n > 0) {
        const r = await client.query(
          `UPDATE manual_item_qty
              SET current_qty = current_qty + $2, updated_at = now()
            WHERE custom_sku_id = (
              SELECT cs.id FROM custom_skus cs WHERE cs.sku = $1 AND cs.archived = FALSE LIMIT 1
            )`,
          [sku, n],
        );
        rows = r.rowCount ?? 0;
      }
      const restored = rows > 0 ? n : 0;
      manualIncremented += restored;
      detail.push({ sku, qty, kind: "manual", restored });
      continue;
    }

    detail.push({ sku, qty, result: "not taken by the sale — nothing to put back" });
  }

  await finish(restoredInStock, manualIncremented, orderName);
  return { restoredInStock, manualIncremented };
}
