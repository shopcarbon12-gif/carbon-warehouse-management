/**
 * Shopify inventory quantity sync — WMS is the source of truth (user directive:
 * "ALL quantities on Shopify must match WMS", including zeros).
 *
 * For every LINKED variant (has shopify_inventory_item_id), set Shopify's
 * available quantity at the primary location to the WMS on-hand (in-stock EPC
 * count). Quantity ONLY — nothing else on Shopify is touched. Products that are
 * not linked (not on Shopify) are never touched.
 *
 *  • full = true  → write every linked variant (initial reconcile).
 *  • full = false → write only variants whose WMS count changed since last sync
 *                   (the periodic auto-sync).
 */
import type { Pool } from "pg";
import {
  resolveShopContext,
  primaryLocationId,
  setInventoryQuantity,
  enableInventoryTracking,
  activateInventory,
  type ShopCtx,
} from "@/lib/server/shopify-write";

type Row = {
  id: string;
  inv: string;
  last: number | null;
  qty: number;
};

async function selectRows(pool: Pool, full: boolean): Promise<Row[]> {
  // WMS on-hand = in-stock EPC count per variant. Single-location store.
  const r = await pool.query<{ id: string; inv: string; last: number | null; qty: number }>(
    `SELECT cs.id::text AS id,
            cs.shopify_inventory_item_id AS inv,
            cs.shopify_qty_synced AS last,
            COALESCE(cnt.q, 0)::int AS qty
       FROM custom_skus cs
       LEFT JOIN (
         SELECT custom_sku_id, COUNT(*)::int AS q
           FROM items WHERE status = 'in-stock' GROUP BY custom_sku_id
       ) cnt ON cnt.custom_sku_id = cs.id
      WHERE cs.archived = FALSE
        AND cs.shopify_inventory_item_id IS NOT NULL
        ${full ? "" : "AND COALESCE(cnt.q, 0) IS DISTINCT FROM cs.shopify_qty_synced"}`,
  );
  return r.rows;
}

async function pushOne(
  pool: Pool,
  ctx: ShopCtx,
  locationId: string,
  row: Row,
): Promise<boolean> {
  // First time we touch this variant, make sure Shopify tracks + stocks it.
  if (row.last === null) {
    await enableInventoryTracking(ctx, row.inv);
    await activateInventory(ctx, row.inv, locationId);
  }
  let res = await setInventoryQuantity(ctx, row.inv, locationId, row.qty);
  if (!res.ok && /not stocked|not been activated|does not have inventory/i.test(res.error || "")) {
    await activateInventory(ctx, row.inv, locationId);
    res = await setInventoryQuantity(ctx, row.inv, locationId, row.qty);
  }
  if (res.ok) {
    await pool.query(
      `UPDATE custom_skus SET shopify_qty_synced = $2, shopify_qty_synced_at = now() WHERE id = $1::uuid`,
      [row.id, row.qty],
    );
  }
  return res.ok;
}

export type InventorySyncResult = { ok: boolean; total: number; pushed: number; failed: number; message: string };

export async function syncShopifyInventory(
  pool: Pool,
  opts: { full: boolean; jobId?: string },
): Promise<InventorySyncResult> {
  const ctx = await resolveShopContext();
  if (!ctx) return { ok: false, total: 0, pushed: 0, failed: 0, message: "Shop not connected." };
  const locationId = await primaryLocationId(ctx);
  if (!locationId) return { ok: false, total: 0, pushed: 0, failed: 0, message: "No Shopify location." };

  const rows = await selectRows(pool, opts.full);
  let pushed = 0;
  let failed = 0;
  for (let i = 0; i < rows.length; i += 1) {
    try {
      if (await pushOne(pool, ctx, locationId, rows[i])) pushed += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
    if (opts.jobId && (i + 1) % 25 === 0) {
      await pool.query(
        `UPDATE sync_jobs SET progress_done = $2, progress_total = $3, progress_pct = $4,
                progress_message = $5 WHERE id = $1::uuid`,
        [opts.jobId, i + 1, rows.length, Math.round(((i + 1) / Math.max(1, rows.length)) * 100), `synced ${pushed} / ${i + 1}`],
      );
    }
  }
  return {
    ok: true,
    total: rows.length,
    pushed,
    failed,
    message: `Synced ${pushed} variant(s) to Shopify${failed ? `, ${failed} failed` : ""}${opts.full ? "" : " (delta)"}.`,
  };
}

/** Worker entrypoint. payload.full=true for a complete reconcile. Self-terminal. */
export async function executeShopifyInventorySync(pool: Pool, jobId: string): Promise<void> {
  const j = await pool.query<{ payload: { full?: boolean } }>(
    `SELECT payload FROM sync_jobs WHERE id = $1::uuid`,
    [jobId],
  );
  const full = j.rows[0]?.payload?.full === true;
  try {
    const res = await syncShopifyInventory(pool, { full, jobId });
    await pool.query(
      `UPDATE sync_jobs SET status = 'completed', progress_pct = 100, finished_at = now(),
              progress_message = $2 WHERE id = $1::uuid`,
      [jobId, res.message.slice(0, 500)],
    );
  } catch (e) {
    await pool.query(
      `UPDATE sync_jobs SET status = 'failed', finished_at = now(), progress_message = $2 WHERE id = $1::uuid`,
      [jobId, (e instanceof Error ? e.message : String(e)).slice(0, 500)],
    );
  }
}
