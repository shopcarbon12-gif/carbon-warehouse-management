/**
 * WMS → Shopify product publish orchestrator (M1/P1.4).
 *
 * Reads a WMS matrix + its active variants, validates, then create-or-updates
 * the Shopify product via `productSet` (idempotent on the stored product id),
 * sets on-hand from WMS EPC counts, publishes to the Online Store, and
 * persists the Shopify ids back onto the WMS rows so re-publishing updates the
 * SAME product instead of duplicating it.
 *
 * `pushMatrixToShopify` is the reusable core; `executeShopifyProductPush` is
 * the worker entrypoint for the `shopify_product_push` job type.
 */
import type { Pool } from "pg";
import {
  resolveShopContext,
  productSet,
  primaryLocationId,
  setInventoryQuantitiesBulk,
  onlineStorePublicationId,
  publishToPublication,
  type SetVariant,
  type ShopVariant,
} from "@/lib/server/shopify-write";
import {
  validateMatrixForPublish,
  type PublishVariantRow,
} from "@/lib/server/shopify-publish-validate";

type MatrixRow = {
  id: string;
  description: string | null;
  brand: string | null;
  vendor: string | null;
  category: string | null;
  subcategory_1: string | null;
  shopify_product_id: string | null;
};
type VariantRow = PublishVariantRow & {
  upc: string | null;
  default_cost: string | null;
};

export type PublishResult = {
  ok: boolean;
  status: "published" | "held" | "error";
  productId?: string;
  message: string;
  warnings: string[];
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 250);
}

/** Distinct, non-empty, first-seen order. */
function distinct(vals: Array<string | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of vals) {
    const t = (v || "").trim();
    if (t && !seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out;
}

export async function pushMatrixToShopify(
  pool: Pool,
  matrixId: string,
  locationId: string,
): Promise<PublishResult> {
  const warnings: string[] = [];
  const mr = await pool.query<MatrixRow>(
    `SELECT id::text, description, brand, vendor, category, subcategory_1,
            shopify_product_id
       FROM matrices WHERE id = $1::uuid`,
    [matrixId],
  );
  const matrix = mr.rows[0];
  if (!matrix) return { ok: false, status: "error", message: "Matrix not found", warnings };

  const vr = await pool.query<VariantRow>(
    `SELECT id::text, sku, color_code, size, retail_price::text AS retail_price,
            upc, default_cost::text AS default_cost
       FROM custom_skus
      WHERE matrix_id = $1::uuid AND archived = FALSE
      ORDER BY size, color_code`,
    [matrixId],
  );
  const variants = vr.rows;

  // ---- validate ---------------------------------------------------------
  const val = await validateMatrixForPublish(pool, matrixId, variants);
  if (!val.ok) {
    const msg = val.errors.join(" ");
    await setStatus(pool, matrixId, "held", msg);
    return { ok: false, status: "held", message: msg, warnings: val.warnings };
  }

  // ---- build options + variant set --------------------------------------
  const colors = distinct(variants.map((v) => v.color_code));
  const sizes = distinct(variants.map((v) => v.size));
  const options: Array<{ name: string; values: string[] }> = [];
  if (colors.length) options.push({ name: "Color", values: colors });
  if (sizes.length) options.push({ name: "Size", values: sizes });
  if (!options.length && variants.length > 1) {
    const msg = "Product has multiple variants but no Color/Size options.";
    await setStatus(pool, matrixId, "held", msg);
    return { ok: false, status: "held", message: msg, warnings };
  }

  const setVariants: SetVariant[] = variants.map((v) => {
    const optionValues: SetVariant["optionValues"] = [];
    if (colors.length) optionValues.push({ optionName: "Color", name: (v.color_code || "").trim() });
    if (sizes.length) optionValues.push({ optionName: "Size", name: (v.size || "").trim() });
    return {
      optionValues,
      sku: (v.sku || "").trim(),
      price: v.retail_price != null ? String(v.retail_price) : undefined,
      barcode: (v.upc || "").trim() || undefined,
    };
  });

  // ---- Shopify context --------------------------------------------------
  const ctx = await resolveShopContext();
  if (!ctx) {
    const msg = "Shopify not connected (SHOPIFY_SHOP_DOMAIN / admin token missing).";
    await setStatus(pool, matrixId, "error", msg);
    return { ok: false, status: "error", message: msg, warnings };
  }

  await setStatus(pool, matrixId, "pushing", null);

  const title = (matrix.description || variants[0]?.sku || "Untitled product").trim();
  const vendor = (matrix.brand || matrix.vendor || "").trim() || undefined;
  const productType = (matrix.subcategory_1 || matrix.category || "").trim() || undefined;

  const set = await productSet(ctx, {
    productId: matrix.shopify_product_id,
    title,
    vendor,
    productType,
    handle: matrix.shopify_product_id ? undefined : slug(title || variants[0]?.sku || "product"),
    options,
    variants: setVariants,
  });
  if (!set.ok) {
    await setStatus(pool, matrixId, "error", set.error);
    return { ok: false, status: "error", message: set.error, warnings };
  }

  // ---- persist ids (match returned variants by SKU) ---------------------
  const bySku = new Map<string, ShopVariant>();
  for (const sv of set.variants) {
    if (sv.sku) bySku.set(sv.sku.trim().toLowerCase(), sv);
  }
  await pool.query(
    `UPDATE matrices
        SET shopify_product_id = $2,
            shopify_sync_status = 'published',
            shopify_pushed_at = now(),
            shopify_push_error = NULL
      WHERE id = $1::uuid`,
    [matrixId, set.productId],
  );
  for (const v of variants) {
    const sv = bySku.get((v.sku || "").trim().toLowerCase());
    if (!sv) {
      warnings.push(`Variant ${v.sku} not returned by Shopify.`);
      continue;
    }
    await pool.query(
      `UPDATE custom_skus
          SET shopify_variant_id = $2, shopify_inventory_item_id = $3
        WHERE id = $1::uuid`,
      [v.id, sv.id, sv.inventoryItem?.id || null],
    );
  }

  // ---- inventory (on-hand from WMS EPC counts) --------------------------
  const locId = await primaryLocationId(ctx);
  if (locId) {
    const onHand = await onHandBySku(pool, matrixId, locationId);
    // ONE bulk inventorySetQuantities for every variant (was one call per size).
    const quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number }> = [];
    for (const v of variants) {
      const sv = bySku.get((v.sku || "").trim().toLowerCase());
      const invId = sv?.inventoryItem?.id;
      if (!invId) continue;
      quantities.push({ inventoryItemId: invId, locationId: locId, quantity: onHand.get(v.id) || 0 });
    }
    if (quantities.length) {
      const r = await setInventoryQuantitiesBulk(ctx, quantities);
      if (!r.ok) warnings.push(`Inventory: ${r.error}`);
    }
  } else {
    warnings.push("No Shopify location found — inventory not set.");
  }

  // ---- publish to Online Store -----------------------------------------
  const pubId = await onlineStorePublicationId(ctx);
  if (pubId) {
    const r = await publishToPublication(ctx, set.productId, pubId);
    if (!r.ok) warnings.push(`Publish: ${r.error}`);
  } else {
    warnings.push("Online Store publication not found — product is ACTIVE but not published to storefront.");
  }

  if (warnings.length) {
    await pool.query(`UPDATE matrices SET shopify_push_error = $2 WHERE id = $1::uuid`, [
      matrixId,
      `published with warnings: ${warnings.join("; ")}`.slice(0, 2000),
    ]);
  }

  return {
    ok: true,
    status: "published",
    productId: set.productId,
    message: `Published ${variants.length} variant(s) to Shopify.`,
    warnings,
  };
}

async function onHandBySku(
  pool: Pool,
  matrixId: string,
  locationId: string,
): Promise<Map<string, number>> {
  const r = await pool.query<{ id: string; qty: number }>(
    `SELECT i.custom_sku_id::text AS id, COUNT(*)::int AS qty
       FROM items i
       JOIN custom_skus cs ON cs.id = i.custom_sku_id
      WHERE cs.matrix_id = $1::uuid
        AND i.status = 'in-stock'
        AND i.location_id = $2::uuid
      GROUP BY i.custom_sku_id`,
    [matrixId, locationId],
  );
  const m = new Map<string, number>();
  for (const row of r.rows) m.set(row.id, row.qty);
  return m;
}

async function setStatus(
  pool: Pool,
  matrixId: string,
  status: string,
  error: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE matrices SET shopify_sync_status = $2, shopify_push_error = $3 WHERE id = $1::uuid`,
    [matrixId, status, error ? error.slice(0, 2000) : null],
  );
}

/** Worker entrypoint for the `shopify_product_push` job. Self-terminal. */
export async function executeShopifyProductPush(pool: Pool, jobId: string): Promise<void> {
  const j = await pool.query<{ payload: { matrixId?: string; locationId?: string } }>(
    `SELECT payload FROM sync_jobs WHERE id = $1::uuid`,
    [jobId],
  );
  const payload = j.rows[0]?.payload || {};
  const matrixId = payload.matrixId;
  const locationId = payload.locationId;

  const fail = async (message: string) => {
    await pool.query(
      `UPDATE sync_jobs SET status = 'failed', progress_message = $2, finished_at = now() WHERE id = $1::uuid`,
      [jobId, message.slice(0, 500)],
    );
  };

  if (!matrixId || !locationId) return fail("shopify_product_push: missing matrixId/locationId");

  try {
    const result = await pushMatrixToShopify(pool, matrixId, locationId);
    const status = result.ok ? "completed" : "failed";
    const msg = result.ok
      ? `${result.message}${result.warnings.length ? " (" + result.warnings.length + " warnings)" : ""}`
      : `${result.status}: ${result.message}`;
    await pool.query(
      `UPDATE sync_jobs SET status = $2, progress_message = $3, finished_at = now(), progress_pct = 100 WHERE id = $1::uuid`,
      [jobId, status, msg.slice(0, 500)],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (matrixId) await setStatus(pool, matrixId, "error", msg);
    await fail(`shopify_product_push crashed: ${msg}`);
  }
}
