/**
 * Shopify returns and exchanges → WMS tag statuses (owner, 2026-10-05).
 *
 * Exchange released / processed (returns/process):
 *   for each exchange item Shopify has now processed, one LIVE tag of that
 *   item is marked UNKNOWN — exactly what orders/paid does for a new order —
 *   and added to the order's shopify_sale_events.detail. So the order panel
 *   lists it under "Tag marked by this order", and when the exchange ships the
 *   existing orders/fulfilled rule puts any still-UNKNOWN tag back to LIVE.
 *
 * Returned items restocked (reverse_fulfillment_orders/dispose):
 *   for each RESTOCKED disposition, that many of THIS order's tags of the item
 *   go back to LIVE — tags scanned out for the order first (the pieces that
 *   actually shipped), then the ones it marked. Only SOLD or UNKNOWN tags are
 *   touched; damaged, tag killed and anything else are left as they are.
 *
 * When the return is run from the WMS (Shopify → Returns, lib/server/
 * shopify-return-desk.ts) the pieces are scanned instead, and these handlers
 * only cover what was NOT scanned: exchange pieces already scanned out are
 * recorded as scanned_qty before the WMS releases them, and returned pieces
 * scanned in are spent as credit before any other tag of the order is touched.
 *
 * Both are idempotent (shopify_exchange_marks / shopify_return_restocks,
 * migration 0104) and write a STATUS_CHANGE audit row per tag. Shopify's
 * webhook payload is used only to find the Return / ReverseFulfillmentOrder
 * id; everything else is read back from the Admin API, so a payload shape
 * change cannot make the WMS act on stale or partial data.
 */
import type { Pool, PoolClient } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";

/** Find a Shopify gid of the given type anywhere in a webhook payload. */
export function findGid(payload: unknown, type: string): string | null {
  const want = `gid://shopify/${type}/`;
  let found: string | null = null;
  const walk = (v: unknown) => {
    if (found) return;
    if (typeof v === "string" && v.startsWith(want)) found = v;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(payload);
  return found;
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const ctx = await resolveShopContext();
  if (!ctx) throw new Error("Shopify is not connected");
  const r = await runShopifyGraphql<T>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables });
  if (!r.ok || !r.data) {
    const msg = Array.isArray(r.errors) ? (r.errors[0] as { message?: string })?.message : undefined;
    throw new Error(msg || "Shopify returned an error");
  }
  return r.data;
}

const legacy = (gid: string) => gid.split("/").pop() ?? gid;

async function resolveSku(q: Pool | PoolClient, sku: string, variantGid: string | null) {
  const r = await q.query<{ id: string; sku: string; manual: boolean }>(
    `SELECT cs.id::text AS id, cs.sku, COALESCE(m.is_manual_only, FALSE) AS manual
       FROM custom_skus cs JOIN matrices m ON m.id = cs.matrix_id
      WHERE cs.archived = FALSE AND (($2 <> '' AND cs.shopify_variant_id = $2) OR ($1 <> '' AND cs.sku = $1))
      ORDER BY (cs.shopify_variant_id = $2) DESC NULLS LAST
      LIMIT 1`,
    [sku, variantGid ?? ""],
  );
  return r.rows[0] ?? null;
}

async function audit(q: PoolClient, epc: string, from: string, to: string, reason: string) {
  await q.query(
    `INSERT INTO inventory_audit_logs (tenant_id, log_type, entity_type, entity_reference, old_value, new_value, reason, user_id, user_uuid, device_id)
     SELECT l.tenant_id, 'STATUS_CHANGE', 'EPC', i.epc, $2, $3, $4, NULL, NULL, 'shopify'
       FROM items i JOIN locations l ON l.id = i.location_id WHERE i.epc = $1`,
    [epc, from, to, reason],
  );
}

/* ─────────────────────────── exchange processed ─────────────────────────── */

type ReturnData = {
  return: {
    id: string;
    name: string;
    order: { id: string; name: string };
    exchangeLineItems: {
      nodes: Array<{ id: string; variantId: string | null; processedQuantity: number; lineItems: Array<{ sku: string | null }> | null }>;
    };
  } | null;
};

export async function onReturnProcessed(pool: Pool, returnGid: string) {
  const data = await gql<ReturnData>(
    `query R($id: ID!) { return(id: $id) { id name order { id name }
       exchangeLineItems(first: 50) { nodes { id variantId processedQuantity lineItems { sku } } } } }`,
    { id: returnGid },
  );
  const ret = data.return;
  if (!ret) return { ok: true, note: "return not found" };
  const orderId = legacy(ret.order.id);
  const results: Array<Record<string, unknown>> = [];

  for (const ex of ret.exchangeLineItems.nodes) {
    const target = ex.processedQuantity ?? 0;
    if (target <= 0) continue;
    // The SKU from the processed line item; otherwise from the variant in the WMS.
    const skuFromLine = ex.lineItems?.find((l) => l.sku)?.sku ?? "";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO shopify_exchange_marks (exchange_line_item_id, order_id, return_id, return_name, variant_id, sku)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (exchange_line_item_id) DO NOTHING`,
        [ex.id, orderId, ret.id, ret.name, ex.variantId, skuFromLine || null],
      );
      const cur = await client.query<{ marked_qty: number; shortfall: number; scanned_qty: number }>(
        `SELECT marked_qty, shortfall, scanned_qty FROM shopify_exchange_marks WHERE exchange_line_item_id = $1 FOR UPDATE`,
        [ex.id],
      );
      // Pieces scanned out in the WMS are already SOLD — no placeholder for them.
      const done = (cur.rows[0]?.marked_qty ?? 0) + (cur.rows[0]?.shortfall ?? 0) + (cur.rows[0]?.scanned_qty ?? 0);
      const need = target - done;
      if (need <= 0) {
        await client.query("COMMIT");
        results.push({ exchange: ex.id, skipped: "already marked" });
        continue;
      }
      const cs = await resolveSku(client, skuFromLine, ex.variantId);
      if (!cs) {
        await client.query(`UPDATE shopify_exchange_marks SET shortfall = shortfall + $2, updated_at = now() WHERE exchange_line_item_id = $1`, [ex.id, need]);
        await client.query("COMMIT");
        results.push({ exchange: ex.id, sku: skuFromLine, result: "no wms match" });
        continue;
      }
      let epcs: string[] = [];
      if (cs.manual) {
        await client.query(
          `UPDATE manual_item_qty SET current_qty = GREATEST(0, current_qty - $2), updated_at = now() WHERE custom_sku_id = $1::uuid`,
          [cs.id, need],
        );
      } else {
        // Same choice as orders/paid: the oldest LIVE tags of the item.
        const r = await client.query<{ epc: string }>(
          `UPDATE items SET status = 'unknown', last_seen_at = last_seen_at
            WHERE id IN (SELECT id FROM items WHERE custom_sku_id = $1::uuid AND status = 'in-stock'
                          ORDER BY first_scanned_at ASC NULLS FIRST, serial_number ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
            RETURNING epc`,
          [cs.id, need],
        );
        epcs = r.rows.map((x) => x.epc);
        for (const e of epcs) await audit(client, e, "in-stock", "unknown", `shopify_exchange ${ret.name}`);
      }
      const marked = cs.manual ? need : epcs.length;
      await client.query(
        `UPDATE shopify_exchange_marks
            SET sku = $2, custom_sku_id = $3::uuid, marked_qty = marked_qty + $4, shortfall = shortfall + $5,
                epcs = epcs || $6::text[], updated_at = now()
          WHERE exchange_line_item_id = $1`,
        [ex.id, cs.sku, cs.id, marked, need - marked, epcs],
      );
      // Onto the order's sale record, so the order panel and orders/fulfilled see these tags.
      const entry = { sku: cs.sku, qty: need, kind: cs.manual ? "manual" : "rfid", flipped: epcs.length, shortfall: need - marked, epcs, exchange: ret.name };
      const up = await client.query(
        `UPDATE shopify_sale_events SET detail = COALESCE(detail, '[]'::jsonb) || $2::jsonb, flipped_unknown = flipped_unknown + $3
          WHERE order_id = $1`,
        [orderId, JSON.stringify([entry]), epcs.length],
      );
      if (!up.rowCount) {
        await client.query(
          `INSERT INTO shopify_sale_events (order_id, order_name, line_count, flipped_unknown, detail) VALUES ($1, $2, 0, $3, $4::jsonb)`,
          [orderId, ret.order.name, epcs.length, JSON.stringify([entry])],
        );
      }
      await client.query("COMMIT");
      results.push({ exchange: ex.id, sku: cs.sku, marked, shortfall: need - marked, epcs });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  return { ok: true, order: ret.order.name, return: ret.name, results };
}

/* ─────────────────────────── returned items disposed ─────────────────────────── */

type RfoData = {
  reverseFulfillmentOrder: {
    id: string;
    order: { id: string; name: string };
    lineItems: {
      nodes: Array<{
        fulfillmentLineItem: { lineItem: { sku: string | null; variant: { id: string } | null } } | null;
        dispositions: Array<{ id: string; type: string; quantity: number }>;
      }>;
    };
  } | null;
};

export async function onReturnDisposed(pool: Pool, rfoGid: string, returnGid: string | null) {
  const data = await gql<RfoData>(
    `query F($id: ID!) { reverseFulfillmentOrder(id: $id) { id order { id name }
       lineItems(first: 50) { nodes { fulfillmentLineItem { lineItem { sku variant { id } } } dispositions { id type quantity } } } } }`,
    { id: rfoGid },
  );
  const rfo = data.reverseFulfillmentOrder;
  if (!rfo) return { ok: true, note: "reverse fulfillment order not found" };
  const orderId = legacy(rfo.order.id);
  const results: Array<Record<string, unknown>> = [];

  for (const li of rfo.lineItems.nodes) {
    const sku = li.fulfillmentLineItem?.lineItem.sku ?? "";
    const variant = li.fulfillmentLineItem?.lineItem.variant?.id ?? null;
    for (const d of li.dispositions) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const claim = await client.query(
          `INSERT INTO shopify_return_restocks (disposition_id, order_id, return_id, sku, disposition, quantity)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (disposition_id) DO NOTHING RETURNING disposition_id`,
          [d.id, orderId, returnGid, sku || null, d.type, d.quantity],
        );
        if (!claim.rowCount || d.type !== "RESTOCKED" || d.quantity <= 0) {
          await client.query("COMMIT");
          results.push({ disposition: d.id, type: d.type, skipped: claim.rowCount ? "not restocked" : "already handled" });
          continue;
        }
        const cs = await resolveSku(client, sku, variant);
        if (!cs) {
          await client.query("COMMIT");
          results.push({ disposition: d.id, sku, result: "no wms match" });
          continue;
        }
        if (cs.manual) {
          await client.query(`UPDATE manual_item_qty SET current_qty = current_qty + $2, updated_at = now() WHERE custom_sku_id = $1::uuid`, [cs.id, d.quantity]);
          await client.query(`UPDATE shopify_return_restocks SET restored = $2 WHERE disposition_id = $1`, [d.id, d.quantity]);
          await client.query("COMMIT");
          results.push({ disposition: d.id, sku: cs.sku, restored: d.quantity, manual: true });
          continue;
        }
        /* Pieces scanned in on the WMS Returns screen are already LIVE: spend
           them first, and only restore other tags for whatever was not scanned. */
        const credit = await client.query<{ scanned: number; used: number }>(
          `SELECT (SELECT count(DISTINCT epc)::int FROM scan_out_events
                     WHERE order_id = $1 AND action = 'scan_in' AND custom_sku_id = $2::uuid) AS scanned,
                  (SELECT COALESCE(sum(r.credit_used), 0)::int FROM shopify_return_restocks r
                     WHERE r.order_id = $1 AND r.sku = $3) AS used`,
          [orderId, cs.id, cs.sku],
        );
        const creditLeft = Math.max(0, (credit.rows[0]?.scanned ?? 0) - (credit.rows[0]?.used ?? 0));
        const creditUsed = Math.min(creditLeft, d.quantity);
        const toRestore = d.quantity - creditUsed;
        await client.query(`UPDATE shopify_return_restocks SET credit_used = $2, sku = $3 WHERE disposition_id = $1`, [d.id, creditUsed, cs.sku]);
        /* This order's tags of the item: scanned out for it first (the pieces
           that shipped), then the ones it marked; only SOLD or UNKNOWN; never
           one an earlier restock already put back. */
        const already = await client.query<{ epc: string }>(
          `SELECT unnest(epcs) AS epc FROM shopify_return_restocks WHERE order_id = $1`,
          [orderId],
        );
        const used = new Set(already.rows.map((r) => r.epc));
        const shipped = await client.query<{ epc: string }>(
          `SELECT epc FROM (SELECT DISTINCT ON (epc) epc, action, created_at FROM scan_out_events
                              WHERE order_id = $1 AND epc IS NOT NULL AND action IN ('scan_out','undo')
                              ORDER BY epc, created_at DESC, id DESC) x
            WHERE action = 'scan_out' ORDER BY created_at`,
          [orderId],
        );
        const ev = await client.query<{ detail: Array<{ epcs?: string[] }> | null }>(`SELECT detail FROM shopify_sale_events WHERE order_id = $1`, [orderId]);
        const marked = (ev.rows[0]?.detail ?? []).flatMap((x) => (Array.isArray(x.epcs) ? x.epcs : []));
        // Tags put IN TRANSIT when the return was approved come first — they are the pieces coming back.
        const tr = await client.query<{ in_transit: Array<{ epcs?: string[] }> }>(`SELECT in_transit FROM shopify_return_approvals WHERE order_id = $1`, [orderId]);
        const transit = tr.rows.flatMap((r) => (r.in_transit ?? []).flatMap((x) => x.epcs ?? []));
        const ordered = [...transit, ...shipped.rows.map((r) => r.epc), ...marked].filter((e, i, a) => a.indexOf(e) === i && !used.has(e));
        const cand = ordered.length
          ? await client.query<{ epc: string; status: string }>(
              `SELECT epc, status FROM items WHERE epc = ANY($1::text[]) AND custom_sku_id = $2::uuid AND status IN ('in-transit','sold','unknown') FOR UPDATE`,
              [ordered, cs.id],
            )
          : { rows: [] as Array<{ epc: string; status: string }> };
        const byEpc = new Map(cand.rows.map((r) => [r.epc, r.status]));
        const pick = ordered.filter((e) => byEpc.has(e)).slice(0, toRestore);
        for (const e of pick) {
          await client.query(`UPDATE items SET status = 'in-stock' WHERE epc = $1`, [e]);
          await audit(client, e, byEpc.get(e)!, "in-stock", `shopify_return_restock ${rfo.order.name}`);
        }
        await client.query(`UPDATE shopify_return_restocks SET restored = $2, epcs = $3::text[] WHERE disposition_id = $1`, [d.id, pick.length, pick]);
        await client.query("COMMIT");
        results.push({ disposition: d.id, sku: cs.sku, restocked: d.quantity, scannedIn: creditUsed, restored: pick.length, epcs: pick });
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }
  }
  return { ok: true, order: rfo.order.name, results };
}

/* ─────────────────────────── return approved ─────────────────────────── */

type ApproveData = {
  return: {
    id: string;
    name: string;
    status: string;
    order: { id: string; name: string };
    returnLineItems: { nodes: Array<{ quantity?: number; fulfillmentLineItem?: { lineItem: { sku: string | null; variant: { id: string } | null } } | null }> };
    exchangeLineItems: { nodes: Array<{ id: string; variantId: string | null; quantity: number }> };
  } | null;
};

/**
 * A return approved in Shopify ("Return in progress") — owner's rule, 2026-10-05:
 *  - each exchange item: one LIVE tag → UNKNOWN now, so the WMS count (and its
 *    push to Shopify) already leaves it out; the piece actually sent is
 *    scanned out later, and orders/fulfilled puts any still-UNKNOWN tag back;
 *  - each returned piece: one of this order's tags of the item → IN TRANSIT
 *    (not web-sellable), chosen from SOLD tags scanned out for the order first,
 *    then the order's placeholders. Scanning the piece in makes it LIVE.
 * Runs once per return (shopify_return_approvals); called by the returns/approve
 * webhook and, as a safety net, whenever the WMS lists open returns.
 */
export async function onReturnApproved(pool: Pool, returnGid: string) {
  const data = await gql<ApproveData>(
    `query A($id: ID!) { return(id: $id) { id name status order { id name }
       returnLineItems(first: 50) { nodes { ... on ReturnLineItem { quantity fulfillmentLineItem { lineItem { sku variant { id } } } } } }
       exchangeLineItems(first: 50) { nodes { id variantId quantity } } } }`,
    { id: returnGid },
  );
  const ret = data.return;
  if (!ret) return { ok: true, note: "return not found" };
  if (ret.status !== "OPEN") return { ok: true, note: `return is ${ret.status}` };
  const orderId = legacy(ret.order.id);
  const returnId = legacy(ret.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `INSERT INTO shopify_return_approvals (return_id, order_id, return_name) VALUES ($1, $2, $3)
       ON CONFLICT (return_id) DO NOTHING RETURNING return_id`,
      [returnId, orderId, ret.name],
    );
    if (!claim.rowCount) {
      await client.query("COMMIT");
      return { ok: true, duplicate: true };
    }

    // 1. Exchange items → one LIVE tag each UNKNOWN (counted in shopify_exchange_marks, so release adds none).
    const entries: Array<Record<string, unknown>> = [];
    for (const ex of ret.exchangeLineItems.nodes) {
      const cs = await resolveSku(client, "", ex.variantId);
      await client.query(
        `INSERT INTO shopify_exchange_marks (exchange_line_item_id, order_id, return_id, return_name, variant_id, sku, custom_sku_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid) ON CONFLICT (exchange_line_item_id) DO NOTHING`,
        [ex.id, orderId, ret.id, ret.name, ex.variantId, cs?.sku ?? null, cs?.id ?? null],
      );
      const cur = await client.query<{ marked_qty: number; shortfall: number; scanned_qty: number | null }>(
        `SELECT marked_qty, shortfall, scanned_qty FROM shopify_exchange_marks WHERE exchange_line_item_id = $1 FOR UPDATE`,
        [ex.id],
      );
      const c = cur.rows[0];
      const need = ex.quantity - (c?.marked_qty ?? 0) - (c?.shortfall ?? 0) - (c?.scanned_qty ?? 0);
      if (need <= 0) continue;
      if (!cs) {
        await client.query(`UPDATE shopify_exchange_marks SET shortfall = shortfall + $2 WHERE exchange_line_item_id = $1`, [ex.id, need]);
        continue;
      }
      let epcs: string[] = [];
      if (cs.manual) {
        await client.query(`UPDATE manual_item_qty SET current_qty = GREATEST(0, current_qty - $2), updated_at = now() WHERE custom_sku_id = $1::uuid`, [cs.id, need]);
      } else {
        const r = await client.query<{ epc: string }>(
          `UPDATE items SET status = 'unknown', last_seen_at = last_seen_at
            WHERE id IN (SELECT id FROM items WHERE custom_sku_id = $1::uuid AND status = 'in-stock'
                          ORDER BY first_scanned_at ASC NULLS FIRST, serial_number ASC LIMIT $2 FOR UPDATE SKIP LOCKED)
            RETURNING epc`,
          [cs.id, need],
        );
        epcs = r.rows.map((x) => x.epc);
        for (const e of epcs) await audit(client, e, "in-stock", "unknown", `shopify_exchange ${ret.name}`);
      }
      const marked = cs.manual ? need : epcs.length;
      await client.query(
        `UPDATE shopify_exchange_marks SET marked_qty = marked_qty + $2, shortfall = shortfall + $3, epcs = epcs || $4::text[], updated_at = now()
          WHERE exchange_line_item_id = $1`,
        [ex.id, marked, need - marked, epcs],
      );
      entries.push({ sku: cs.sku, qty: need, kind: cs.manual ? "manual" : "rfid", flipped: epcs.length, shortfall: need - marked, epcs, exchange: ret.name });
    }
    if (entries.length) {
      const flipped = entries.reduce((n, x) => n + Number(x.flipped ?? 0), 0);
      const up = await client.query(
        `UPDATE shopify_sale_events SET detail = COALESCE(detail, '[]'::jsonb) || $2::jsonb, flipped_unknown = flipped_unknown + $3 WHERE order_id = $1`,
        [orderId, JSON.stringify(entries), flipped],
      );
      if (!up.rowCount) {
        await client.query(
          `INSERT INTO shopify_sale_events (order_id, order_name, line_count, flipped_unknown, detail) VALUES ($1, $2, 0, $3, $4::jsonb)`,
          [orderId, ret.order.name, flipped, JSON.stringify(entries)],
        );
      }
    }

    // 2. Returned pieces → one of this order's tags each IN TRANSIT.
    const shipped = await client.query<{ epc: string }>(
      `SELECT epc FROM (SELECT DISTINCT ON (epc) epc, action, created_at FROM scan_out_events
                          WHERE order_id = $1 AND epc IS NOT NULL AND action IN ('scan_out','undo')
                          ORDER BY epc, created_at DESC, id DESC) x
        WHERE action = 'scan_out' ORDER BY created_at`,
      [orderId],
    );
    const ev = await client.query<{ detail: Array<{ epcs?: string[]; exchange?: string }> | null }>(`SELECT detail FROM shopify_sale_events WHERE order_id = $1`, [orderId]);
    // The order's own placeholders — not the ones just marked for the exchange.
    const placeholders = (ev.rows[0]?.detail ?? []).filter((x) => !x.exchange).flatMap((x) => (Array.isArray(x.epcs) ? x.epcs : []));
    const inTransit: Array<{ sku: string; epcs: string[]; shortfall: number }> = [];
    const taken = new Set<string>();
    for (const li of ret.returnLineItems.nodes) {
      const qty = li.quantity ?? 0;
      const lineItem = li.fulfillmentLineItem?.lineItem;
      if (!qty || !lineItem) continue;
      const cs = await resolveSku(client, lineItem.sku ?? "", lineItem.variant?.id ?? null);
      if (!cs || cs.manual) continue;
      const order = [...shipped.rows.map((r) => r.epc), ...placeholders].filter((e, i, a) => a.indexOf(e) === i && !taken.has(e));
      const cand = order.length
        ? await client.query<{ epc: string; status: string }>(
            `SELECT epc, status FROM items WHERE epc = ANY($1::text[]) AND custom_sku_id = $2::uuid AND status IN ('sold','unknown') FOR UPDATE`,
            [order, cs.id],
          )
        : { rows: [] as Array<{ epc: string; status: string }> };
      const st = new Map(cand.rows.map((r) => [r.epc, r.status]));
      // SOLD first — those are pieces the WMS knows went out; then placeholders.
      const pick = [...order.filter((e) => st.get(e) === "sold"), ...order.filter((e) => st.get(e) === "unknown")].slice(0, qty);
      for (const e of pick) {
        taken.add(e);
        await client.query(`UPDATE items SET status = 'in-transit' WHERE epc = $1`, [e]);
        await audit(client, e, st.get(e)!, "in-transit", `shopify_return ${ret.name}`);
      }
      inTransit.push({ sku: cs.sku, epcs: pick, shortfall: qty - pick.length });
    }
    await client.query(`UPDATE shopify_return_approvals SET in_transit = $2::jsonb WHERE return_id = $1`, [returnId, JSON.stringify(inTransit)]);
    await client.query("COMMIT");
    return { ok: true, order: ret.order.name, return: ret.name, exchange: entries, inTransit };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
