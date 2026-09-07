import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import type { ShopCtx } from "@/lib/server/shopify-write";
import { applySetBanner, pictureForProduct, type SetPicture } from "@/lib/seo/setNotice";

/**
 * Push the "Complete the Look" banner into a product's Shopify description.
 *
 * The banner lives in descriptionHtml because that is where the product page
 * renders it, between the copy and the variant pickers. Only two paths write
 * that field — publishing a set and saving SEO — and both go through here, so
 * one cannot quietly undo the other's work.
 *
 * Every call rewrites from the current Shopify description: strip whatever
 * banner is there, then add the right one back, or none if the product is no
 * longer part of a set. That makes the operation idempotent and makes unticking
 * "Set" remove the banner rather than orphan it.
 */

export interface SetBannerResult {
  matrixId: string;
  productId: string | null;
  picture: SetPicture | null;
  changed: boolean;
  error?: string;
}

/** What the WMS knows about a product's set status and numbering. */
async function loadMatrixSetInfo(pool: Pool, matrixIds: string[]) {
  const r = await pool.query<{
    id: string;
    upc: string | null;
    is_set: boolean;
    shopify_product_id: string | null;
    skus: string[] | null;
  }>(
    `SELECT m.id::text AS id,
            m.upc,
            m.is_set,
            m.shopify_product_id,
            array_agg(cs.sku) FILTER (WHERE cs.sku IS NOT NULL) AS skus
       FROM matrices m
       LEFT JOIN custom_skus cs ON cs.matrix_id = m.id
      WHERE m.id = ANY($1::uuid[])
      GROUP BY m.id`,
    [matrixIds],
  );
  return r.rows;
}

/**
 * Every matrix whose banner this change affects: the product itself plus the
 * rest of its set. Saving one half has to update the other half too — that is
 * what "all the related items get the notice" means.
 */
export async function resolveSetGroupMatrixIds(pool: Pool, matrixId: string): Promise<string[]> {
  const r = await pool.query<{ id: string }>(
    `SELECT m.id::text AS id
       FROM matrices m
      WHERE m.id = $1::uuid
         OR (m.set_group_id IS NOT NULL
             AND m.set_group_id = (SELECT set_group_id FROM matrices WHERE id = $1::uuid))`,
    [matrixId],
  );
  return r.rows.map((x) => x.id);
}

export async function syncSetBanners(
  pool: Pool,
  ctx: ShopCtx,
  matrixIds: string[],
): Promise<SetBannerResult[]> {
  if (!matrixIds.length) return [];
  const rows = await loadMatrixSetInfo(pool, matrixIds);
  const out: SetBannerResult[] = [];

  for (const row of rows) {
    const productId = row.shopify_product_id;
    if (!productId) {
      /* Not on Shopify yet — nothing to write. The banner lands when it is
         published, because publishing runs this too. */
      out.push({ matrixId: row.id, productId: null, picture: null, changed: false });
      continue;
    }

    const picture = row.is_set ? pictureForProduct(row.skus || [], row.upc) : null;

    try {
      const read = await runShopifyGraphql<{ product?: { descriptionHtml?: string | null } }>({
        shop: ctx.shop,
        token: ctx.token,
        apiVersion: ctx.apiVersion,
        query: `query($id: ID!) { product(id: $id) { descriptionHtml } }`,
        variables: { id: productId },
      });
      if (!read.ok || read.errors) throw new Error("Could not read the product description");

      const currentHtml = String(read.data?.product?.descriptionHtml ?? "");
      const nextHtml = applySetBanner(currentHtml, picture);
      if (nextHtml === currentHtml) {
        out.push({ matrixId: row.id, productId, picture, changed: false });
        continue;
      }

      const write = await runShopifyGraphql<{
        productUpdate?: { userErrors?: Array<{ message: string }> };
      }>({
        shop: ctx.shop,
        token: ctx.token,
        apiVersion: ctx.apiVersion,
        query: `mutation($input: ProductInput!) {
          productUpdate(input: $input) { product { id } userErrors { field message } }
        }`,
        variables: { input: { id: productId, descriptionHtml: nextHtml } },
      });
      const errs = write.data?.productUpdate?.userErrors || [];
      if (!write.ok || write.errors || errs.length) {
        throw new Error(
          errs.map((err: { message: string }) => err.message).join("; ") ||
            "Shopify rejected the update",
        );
      }
      out.push({ matrixId: row.id, productId, picture, changed: true });
    } catch (e) {
      /* One product failing must not abandon the rest of the set — the caller
         reports what did and did not land. */
      out.push({
        matrixId: row.id,
        productId,
        picture,
        changed: false,
        error: e instanceof Error ? e.message : "Banner update failed",
      });
    }
  }

  return out;
}
