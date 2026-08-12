/**
 * Link an existing WMS matrix to its ALREADY-EXISTING Shopify product, by SKU.
 *
 * The 768 products predate WMS-side publishing, so `matrices.shopify_product_id`
 * is null and every tab prompts "Check & Publish". This backfills the Shopify
 * product + per-variant ids (variant + inventory item + image url) so those
 * products are recognised as published — and a later Check & Publish becomes an
 * idempotent UPDATE instead of creating a duplicate.
 */
import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";

export type LinkResult = { ok: boolean; linked: boolean; productId?: string; message: string };

type ShopProduct = {
  id: string;
  featuredImage?: { url?: string } | null;
  variants?: { nodes?: Array<{ id: string; sku?: string | null; inventoryItem?: { id: string } | null; image?: { url?: string } | null }> };
};

const PRODUCT_BY_SKU = `query($q: String!) {
  products(first: 10, query: $q) {
    nodes {
      id
      featuredImage { url }
      variants(first: 100) { nodes { id sku inventoryItem { id } image { url } } }
    }
  }
}`;

export async function linkMatrixToShopify(pool: Pool, matrixId: string): Promise<LinkResult> {
  const vr = await pool.query<{ id: string; sku: string | null }>(
    `SELECT id::text, sku FROM custom_skus WHERE matrix_id = $1::uuid AND archived = FALSE`,
    [matrixId],
  );
  const skus = vr.rows.map((v) => (v.sku || "").trim()).filter(Boolean);
  if (!skus.length) return { ok: false, linked: false, message: "No SKUs to match." };

  const ctx = await resolveShopContext();
  if (!ctx) return { ok: false, linked: false, message: "Shop not connected." };

  // Search Shopify by up to a few of the matrix's SKUs; pick the product whose
  // variant SKUs overlap ours the most.
  const skuSet = new Set(skus.map((s) => s.toLowerCase()));
  const candidates = new Map<string, ShopProduct>();
  for (const sku of skus.slice(0, 5)) {
    const r = await runShopifyGraphql<{ products?: { nodes?: ShopProduct[] } }>({
      shop: ctx.shop,
      token: ctx.token,
      apiVersion: ctx.apiVersion,
      query: PRODUCT_BY_SKU,
      variables: { q: `sku:${JSON.stringify(sku)}` },
    });
    for (const p of r.data?.products?.nodes || []) candidates.set(p.id, p);
    if (candidates.size && skus.length <= 2) break;
  }
  if (!candidates.size) return { ok: true, linked: false, message: "No matching Shopify product found." };

  let best: ShopProduct | null = null;
  let bestOverlap = 0;
  for (const p of candidates.values()) {
    const overlap = (p.variants?.nodes || []).filter(
      (v) => v.sku && skuSet.has(v.sku.trim().toLowerCase()),
    ).length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = p;
    }
  }
  if (!best || bestOverlap === 0) {
    return { ok: true, linked: false, message: "No SKU overlap with a Shopify product." };
  }

  // Map Shopify variants by SKU and persist.
  const bySku = new Map<string, { id: string; inv?: string; img?: string }>();
  for (const v of best.variants?.nodes || []) {
    if (v.sku) bySku.set(v.sku.trim().toLowerCase(), { id: v.id, inv: v.inventoryItem?.id, img: v.image?.url });
  }
  await pool.query(
    `UPDATE matrices
        SET shopify_product_id = $2,
            shopify_sync_status = 'published',
            shopify_pushed_at = COALESCE(shopify_pushed_at, now())
      WHERE id = $1::uuid`,
    [matrixId, best.id],
  );
  let mapped = 0;
  for (const v of vr.rows) {
    const sv = bySku.get((v.sku || "").trim().toLowerCase());
    if (!sv) continue;
    mapped += 1;
    await pool.query(
      `UPDATE custom_skus
          SET shopify_variant_id = $2,
              shopify_inventory_item_id = COALESCE($3, shopify_inventory_item_id),
              shopify_image_url = COALESCE(shopify_image_url, $4)
        WHERE id = $1::uuid`,
      [v.id, sv.id, sv.inv || null, sv.img || null],
    );
  }
  return {
    ok: true,
    linked: true,
    productId: best.id,
    message: `Linked to existing Shopify product (${mapped}/${vr.rows.length} variants mapped).`,
  };
}

/** Worker job: link every unlinked matrix (bulk backfill). Self-terminal. */
export async function executeShopifyLinkAll(pool: Pool, jobId: string): Promise<void> {
  const rows = await pool.query<{ id: string }>(
    `SELECT id::text FROM matrices WHERE shopify_product_id IS NULL AND is_manual_only = FALSE`,
  );
  const ids = rows.rows.map((r) => r.id);
  let linked = 0;
  let done = 0;
  for (const id of ids) {
    try {
      const res = await linkMatrixToShopify(pool, id);
      if (res.linked) linked += 1;
    } catch {
      /* skip and continue */
    }
    done += 1;
    if (done % 10 === 0) {
      await pool.query(
        `UPDATE sync_jobs SET progress_done = $2, progress_total = $3,
                progress_pct = $4, progress_message = $5 WHERE id = $1::uuid`,
        [jobId, done, ids.length, Math.round((done / Math.max(1, ids.length)) * 100), `linked ${linked}/${done}`],
      );
    }
  }
  await pool.query(
    `UPDATE sync_jobs SET status = 'completed', progress_pct = 100, finished_at = now(),
            progress_message = $2 WHERE id = $1::uuid`,
    [jobId, `Linked ${linked} of ${ids.length} products to existing Shopify products.`],
  );
}
