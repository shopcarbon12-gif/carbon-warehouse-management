/**
 * Shopify → Returns: returns are handled in the WMS (owner, 2026-10-05).
 *
 * The only step left in Shopify is approving the request. From "Return in
 * progress" on:
 *   1. the returned pieces are SCANNED IN at the .87 antenna — SOLD / UNKNOWN /
 *      RETURN → LIVE — which also proves each tag still reads;
 *   2. the exchange pieces are SCANNED OUT against the order — LIVE / UNKNOWN →
 *      SOLD;
 *   3. "Complete in Shopify" processes the return through the Admin API: the
 *      scanned-in pieces as RESTOCKED, and the exchange items released so the
 *      order can be shipped.
 *
 * The returns/process and dispose webhooks (lib/server/shopify-returns.ts)
 * still fire after step 3; they are told what was scanned (scanned_qty, and
 * the scan-ins themselves) and only act on what was not.
 */
import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import { primaryLocationId, resolveShopContext, type ShopCtx } from "@/lib/server/shopify-write";
import { lookupItems, type ScanOutItem } from "@/lib/server/scan-out";
import { onReturnApproved } from "@/lib/server/shopify-returns";

type Money = { amount: string; currencyCode: string };

async function ctxOrThrow(): Promise<ShopCtx> {
  const ctx = await resolveShopContext();
  if (!ctx) throw new Error("Shopify is not connected.");
  return ctx;
}

async function gql<T>(ctx: ShopCtx, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await runShopifyGraphql<T>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables });
  if (!r.ok || !r.data) {
    const msg = Array.isArray(r.errors) ? (r.errors[0] as { message?: string })?.message : undefined;
    throw new Error(msg || "Shopify returned an error.");
  }
  return r.data;
}

const legacy = (gid: string) => gid.split("/").pop() ?? gid;

/**
 * Safety net for the returns/approve webhook: apply the approval rule (exchange
 * items → UNKNOWN, returned pieces → IN TRANSIT) to any open return the WMS has
 * not seen approved yet. A failure is logged, never shown — the page still loads.
 */
async function ensureApproved(pool: Pool, returnIds: string[]) {
  if (!returnIds.length) return;
  const seen = await pool.query<{ return_id: string }>(`SELECT return_id FROM shopify_return_approvals WHERE return_id = ANY($1::text[])`, [returnIds]);
  const done = new Set(seen.rows.map((r) => r.return_id));
  for (const id of returnIds) {
    if (done.has(id)) continue;
    await onReturnApproved(pool, `gid://shopify/Return/${id}`).catch((e) => console.error("[returns] approve", id, e));
  }
}

/* ─────────────────────────────── the list ─────────────────────────────── */

export type ReturnRow = {
  id: string;
  name: string;
  createdAt: string;
  orderId: string;
  orderName: string;
  customer: string | null;
  returning: number;
  exchanging: number;
  scannedIn: number;
};

export async function listOpenReturns(pool: Pool): Promise<ReturnRow[]> {
  const ctx = await ctxOrThrow();
  const d = await gql<{
    orders: {
      nodes: Array<{
        legacyResourceId: string;
        name: string;
        customer: { displayName: string } | null;
        returns: { nodes: Array<{ id: string; name: string; status: string; createdAt: string; returnLineItems: { nodes: Array<{ quantity?: number; processableQuantity?: number }> }; exchangeLineItems: { nodes: Array<{ processableQuantity: number }> } }> };
      }>;
    };
  }>(
    ctx,
    `{ orders(first: 100, query: "return_status:in_progress", sortKey: UPDATED_AT, reverse: true) { nodes {
        legacyResourceId name customer { displayName }
        returns(first: 10) { nodes { id name status createdAt
          returnLineItems(first: 50) { nodes { ... on ReturnLineItem { quantity processableQuantity } } }
          exchangeLineItems(first: 50) { nodes { processableQuantity } } } } } } }`,
  );
  const rows: ReturnRow[] = [];
  for (const o of d.orders.nodes) {
    for (const r of o.returns.nodes) {
      if (r.status !== "OPEN") continue;
      rows.push({
        id: legacy(r.id),
        name: r.name,
        createdAt: r.createdAt,
        orderId: o.legacyResourceId,
        orderName: o.name,
        customer: o.customer?.displayName ?? null,
        returning: r.returnLineItems.nodes.reduce((t, x) => t + (x.processableQuantity ?? 0), 0),
        exchanging: r.exchangeLineItems.nodes.reduce((t, x) => t + (x.processableQuantity ?? 0), 0),
        scannedIn: 0,
      });
    }
  }
  await ensureApproved(pool, rows.map((r) => r.id));
  if (rows.length) {
    const c = await pool.query<{ return_id: string; n: number }>(
      `SELECT return_id, count(*)::int AS n FROM (
         SELECT DISTINCT ON (epc, return_id) epc, return_id, action FROM scan_out_events
          WHERE return_id = ANY($1::text[]) AND action IN ('scan_in', 'undo') ORDER BY epc, return_id, created_at DESC, id DESC
       ) x WHERE action = 'scan_in' GROUP BY return_id`,
      [rows.map((r) => r.id)],
    );
    const by = new Map(c.rows.map((r) => [r.return_id, r.n]));
    for (const r of rows) r.scannedIn = by.get(r.id) ?? 0;
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ─────────────────────────────── one return ─────────────────────────────── */

export type WmsItem = {
  customSkuId: string | null;
  sku: string | null;
  upc: string | null;
  bin: string | null;
  name: string | null;
  color: string | null;
  size: string | null;
};

export type ReturnLine = WmsItem & {
  id: string;
  rfoLineItemId: string | null;
  title: string;
  variant: string | null;
  image: string | null;
  quantity: number;
  processed: number;
  processable: number;
  reason: string | null;
  note: string | null;
  scannedIn: ScanOutItem[];
  /** Tags of this item put IN TRANSIT when the return was approved. */
  inTransit: ScanOutItem[];
};

export type ExchangeLine = WmsItem & {
  id: string;
  variantId: string | null;
  title: string;
  variant: string | null;
  image: string | null;
  quantity: number;
  processed: number;
  processable: number;
  scannedOut: ScanOutItem[];
};

export type ReturnDetail = {
  id: string;
  gid: string;
  name: string;
  status: string;
  createdAt: string;
  orderId: string;
  orderName: string;
  customer: string | null;
  adminUrl: string;
  lines: ReturnLine[];
  exchanges: ExchangeLine[];
};

async function wmsFor(pool: Pool, sku: string, variantGid: string | null): Promise<WmsItem> {
  const r = await pool.query<{ id: string; sku: string; upc: string | null; name: string | null; color: string | null; size: string | null; bin: string | null }>(
    `SELECT cs.id::text, cs.sku, COALESCE(NULLIF(cs.upc, ''), m.upc) AS upc, m.description AS name, cs.color_code AS color, cs.size,
            COALESCE(
              (SELECT b2.code FROM items i2 JOIN bins b2 ON b2.id = i2.bin_id
                WHERE i2.custom_sku_id = cs.id AND i2.status = 'in-stock' AND b2.archived_at IS NULL
                GROUP BY b2.code ORDER BY count(*) DESC, b2.code LIMIT 1),
              (SELECT b3.code FROM bins b3 WHERE b3.id = cs.assigned_bin_id AND b3.archived_at IS NULL)
            ) AS bin
       FROM custom_skus cs JOIN matrices m ON m.id = cs.matrix_id
      WHERE cs.archived = FALSE AND (($2 <> '' AND cs.shopify_variant_id = $2) OR ($1 <> '' AND cs.sku = $1))
      ORDER BY (cs.shopify_variant_id = $2) DESC NULLS LAST LIMIT 1`,
    [sku, variantGid ?? ""],
  );
  const x = r.rows[0];
  return x
    ? { customSkuId: x.id, sku: x.sku, upc: x.upc, bin: x.bin, name: x.name, color: x.color, size: x.size }
    : { customSkuId: null, sku: sku || null, upc: null, bin: null, name: null, color: null, size: null };
}

/** Tags whose latest scan (here, of this kind, for this order/return) still stands. */
async function standing(pool: Pool, where: string, params: unknown[], kind: "scan_in" | "scan_out"): Promise<Map<string, string[]>> {
  const r = await pool.query<{ epc: string; custom_sku_id: string | null }>(
    `SELECT epc, custom_sku_id::text FROM (
       SELECT DISTINCT ON (epc) epc, custom_sku_id, action, created_at FROM scan_out_events
        WHERE ${where} AND epc IS NOT NULL AND action IN ('${kind}', 'undo')
        ORDER BY epc, created_at DESC, id DESC
     ) x WHERE action = '${kind}' ORDER BY created_at`,
    params,
  );
  const by = new Map<string, string[]>();
  for (const row of r.rows) {
    const k = row.custom_sku_id ?? "";
    by.set(k, [...(by.get(k) ?? []), row.epc]);
  }
  return by;
}

type RawReturn = {
  return: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
    order: { legacyResourceId: string; name: string; customer: { displayName: string } | null };
    returnLineItems: {
      nodes: Array<{
        id?: string;
        quantity?: number;
        processedQuantity?: number;
        processableQuantity?: number;
        returnReasonNote?: string | null;
        customerNote?: string | null;
        fulfillmentLineItem?: { id: string; lineItem: { title: string; variantTitle: string | null; sku: string | null; variant: { id: string } | null; image: { url: string } | null } } | null;
      }>;
    };
    exchangeLineItems: { nodes: Array<{ id: string; quantity: number; processedQuantity: number; processableQuantity: number; variantId: string | null }> };
    reverseFulfillmentOrders: { nodes: Array<{ lineItems: { nodes: Array<{ id: string; fulfillmentLineItem: { id: string } | null }> } }> };
  } | null;
};

async function fetchReturn(ctx: ShopCtx, id: string): Promise<NonNullable<RawReturn["return"]>> {
  const gid = id.startsWith("gid://") ? id : `gid://shopify/Return/${id.replace(/\D/g, "")}`;
  const d = await gql<RawReturn>(
    ctx,
    `query R($id: ID!) { return(id: $id) { id name status createdAt
       order { legacyResourceId name customer { displayName } }
       returnLineItems(first: 50) { nodes { ... on ReturnLineItem { id quantity processedQuantity processableQuantity returnReasonNote customerNote
         fulfillmentLineItem { id lineItem { title variantTitle sku variant { id } image { url(transform: { maxWidth: 160, maxHeight: 160 }) } } } } } }
       exchangeLineItems(first: 50) { nodes { id quantity processedQuantity processableQuantity variantId } }
       reverseFulfillmentOrders(first: 10) { nodes { lineItems(first: 50) { nodes { id fulfillmentLineItem { id } } } } } } }`,
    { id: gid },
  );
  if (!d.return) throw new Error("Return not found.");
  return d.return;
}

export async function getReturn(pool: Pool, id: string): Promise<ReturnDetail> {
  const ctx = await ctxOrThrow();
  let r = await fetchReturn(ctx, id);
  const returnId = legacy(r.id);
  const orderId = r.order.legacyResourceId;
  if (r.status === "OPEN") {
    const before = await pool.query(`SELECT 1 FROM shopify_return_approvals WHERE return_id = $1`, [returnId]);
    if (!before.rowCount) {
      await ensureApproved(pool, [returnId]);
      r = await fetchReturn(ctx, id);
    }
  }
  const ap = await pool.query<{ in_transit: Array<{ epcs?: string[] }> }>(`SELECT in_transit FROM shopify_return_approvals WHERE return_id = $1`, [returnId]);
  const transitEpcs = (ap.rows[0]?.in_transit ?? []).flatMap((x) => x.epcs ?? []);
  const transitItems = await lookupItems(pool, transitEpcs);
  const rfoLine = new Map<string, string>();
  for (const rfo of r.reverseFulfillmentOrders.nodes) for (const li of rfo.lineItems.nodes) if (li.fulfillmentLineItem) rfoLine.set(li.fulfillmentLineItem.id, li.id);

  // Exchange variants: their title, options and image.
  const varIds = r.exchangeLineItems.nodes.map((x) => x.variantId).filter((x): x is string => !!x);
  const vd = varIds.length
    ? await gql<{ nodes: Array<{ id: string; sku: string | null; title: string; product: { title: string }; image: { url: string } | null } | null> }>(
        ctx,
        `query V($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id sku title product { title } image { url(transform: { maxWidth: 160, maxHeight: 160 }) } } } }`,
        { ids: varIds },
      )
    : { nodes: [] };
  const vmap = new Map(vd.nodes.filter((v): v is NonNullable<typeof v> => !!v).map((v) => [v.id, v]));

  const scannedIn = await standing(pool, "return_id = $1", [returnId], "scan_in");
  const scannedOut = await standing(pool, "order_id = $1", [orderId], "scan_out");

  const lines: ReturnLine[] = [];
  for (const n of r.returnLineItems.nodes) {
    if (!n.id || !n.fulfillmentLineItem) continue;
    const li = n.fulfillmentLineItem.lineItem;
    const w = await wmsFor(pool, li.sku ?? "", li.variant?.id ?? null);
    lines.push({
      ...w,
      id: n.id,
      rfoLineItemId: rfoLine.get(n.fulfillmentLineItem.id) ?? null,
      title: li.title,
      variant: li.variantTitle,
      image: li.image?.url ?? null,
      quantity: n.quantity ?? 0,
      processed: n.processedQuantity ?? 0,
      processable: n.processableQuantity ?? 0,
      reason: n.returnReasonNote ?? null,
      note: n.customerNote ?? null,
      scannedIn: await lookupItems(pool, w.customSkuId ? scannedIn.get(w.customSkuId) ?? [] : []),
      inTransit: w.customSkuId ? transitItems.filter((t) => t.customSkuId === w.customSkuId) : [],
    });
  }
  const exchanges: ExchangeLine[] = [];
  for (const x of r.exchangeLineItems.nodes) {
    const v = x.variantId ? vmap.get(x.variantId) : undefined;
    const w = await wmsFor(pool, v?.sku ?? "", x.variantId);
    exchanges.push({
      ...w,
      id: x.id,
      variantId: x.variantId,
      title: v?.product.title ?? "Exchange item",
      variant: v?.title ?? null,
      image: v?.image?.url ?? null,
      quantity: x.quantity,
      processed: x.processedQuantity,
      processable: x.processableQuantity,
      scannedOut: await lookupItems(pool, w.customSkuId ? scannedOut.get(w.customSkuId) ?? [] : []),
    });
  }
  return {
    id: returnId,
    gid: r.id,
    name: r.name,
    status: r.status,
    createdAt: r.createdAt,
    orderId,
    orderName: r.order.name,
    customer: r.order.customer?.displayName ?? null,
    adminUrl: `https://${ctx.shop}/admin/orders/${orderId}`,
    lines,
    exchanges,
  };
}

/** What may still be scanned in, per WMS item: on the return, not yet processed, not yet scanned. */
export function scanInAllowance(d: ReturnDetail): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of d.lines) {
    if (!l.customSkuId) continue;
    const room = l.processable - Math.max(0, l.scannedIn.length - l.processed);
    m.set(l.customSkuId, (m.get(l.customSkuId) ?? 0) + Math.max(0, room));
  }
  return m;
}

/* ─────────────────────────────── complete ─────────────────────────────── */

export async function completeReturn(pool: Pool, id: string): Promise<{ restocked: number; released: number; status: string }> {
  const ctx = await ctxOrThrow();
  const d = await getReturn(pool, id);
  const location = await primaryLocationId(ctx);

  // Returned pieces: what was scanned in and not yet processed, restocked.
  const returnLineItems: Array<Record<string, unknown>> = [];
  let restocked = 0;
  for (const l of d.lines) {
    const fresh = Math.min(l.processable, Math.max(0, l.scannedIn.length - l.processed));
    if (fresh <= 0) continue;
    if (!l.rfoLineItemId) throw new Error(`Shopify has no reverse fulfillment line for ${l.title}.`);
    returnLineItems.push({
      id: l.id,
      quantity: fresh,
      dispositions: [{ reverseFulfillmentOrderLineItemId: l.rfoLineItemId, quantity: fresh, dispositionType: "RESTOCKED", ...(location ? { locationId: location } : {}) }],
    });
    restocked += fresh;
  }

  // Exchange items: released, after telling the webhook how many are already scanned out.
  const exchangeLineItems: Array<Record<string, unknown>> = [];
  let released = 0;
  for (const x of d.exchanges) {
    if (x.processable <= 0) continue;
    await pool.query(
      `INSERT INTO shopify_exchange_marks (exchange_line_item_id, order_id, return_id, return_name, variant_id, sku, custom_sku_id, scanned_qty)
       VALUES ($1, $2, $3, $4, $5, $6, $7::uuid, $8)
       ON CONFLICT (exchange_line_item_id) DO UPDATE SET scanned_qty = EXCLUDED.scanned_qty, updated_at = now()`,
      [x.id, d.orderId, d.gid, d.name, x.variantId, x.sku, x.customSkuId, Math.min(x.quantity, x.scannedOut.length)],
    );
    exchangeLineItems.push({ id: x.id, quantity: x.processable });
    released += x.processable;
  }
  if (!returnLineItems.length && !exchangeLineItems.length) {
    throw new Error("Nothing to complete yet — scan in the returned pieces first.");
  }

  const res = await gql<{
    returnProcess: { return: { status: string } | null; userErrors: Array<{ field: string[] | null; message: string }> };
  }>(
    ctx,
    `mutation P($input: ReturnProcessInput!) { returnProcess(input: $input) { return { status } userErrors { field message } } }`,
    { input: { returnId: d.gid, returnLineItems, exchangeLineItems, notifyCustomer: false } },
  );
  const err = res.returnProcess.userErrors[0];
  if (err) throw new Error(err.message);
  return { restocked, released, status: res.returnProcess.return?.status ?? "?" };
}

export type { Money };
