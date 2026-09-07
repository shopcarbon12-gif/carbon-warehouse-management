import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import type { ShopCtx } from "@/lib/server/shopify-write";
import { applySetNoticeFor, pictureForProduct, type SetPicture } from "@/lib/seo/setNotice";

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
/**
 * The other pieces of each product's set that are actually listed on Shopify.
 *
 * Only listed partners count: a partner that exists in the WMS but has no
 * Shopify product cannot be added to a cart, so for storefront purposes the
 * product is unpaired.
 */
async function loadPartners(pool: Pool, matrixIds: string[]) {
  const r = await pool.query<{ id: string; partner_pid: string }>(
    `SELECT DISTINCT m.id::text AS id, p.shopify_product_id AS partner_pid
       FROM matrices m
       JOIN matrices p
         ON p.set_group_id = m.set_group_id
        AND p.shopify_product_id IS NOT NULL
        AND p.shopify_product_id IS DISTINCT FROM m.shopify_product_id
      WHERE m.id = ANY($1::uuid[])
        AND m.set_group_id IS NOT NULL`,
    [matrixIds],
  );
  const out = new Map<string, string[]>();
  for (const row of r.rows) {
    if (!out.has(row.id)) out.set(row.id, []);
    const list = out.get(row.id)!;
    if (!list.includes(row.partner_pid)) list.push(row.partner_pid);
  }
  return out;
}

/**
 * Shopify handles for a set of product ids.
 *
 * The storefront pairs by handle, because that is what /products/<handle>.js
 * takes — and that endpoint is how the theme reads a partner's live variants and
 * stock without needing an API key in the browser. The WMS does not store
 * handles, so they are read here in one batch.
 */
async function loadHandles(ctx: ShopCtx, productIds: string[]) {
  const out = new Map<string, string>();
  for (let i = 0; i < productIds.length; i += 50) {
    const batch = productIds.slice(i, i + 50);
    const res = await runShopifyGraphql<{ nodes?: Array<{ id?: string; handle?: string } | null> }>({
      shop: ctx.shop,
      token: ctx.token,
      apiVersion: ctx.apiVersion,
      query: `query($ids:[ID!]!){ nodes(ids:$ids){ ... on Product { id handle } } }`,
      variables: { ids: batch },
    });
    for (const n of res.data?.nodes || []) {
      if (n?.id && n.handle) out.set(n.id, n.handle);
    }
  }
  return out;
}

/**
 * Per-variant stock for every piece of the sets these products belong to,
 * keyed COLOUR|SIZE.
 *
 * Needed because Shopify's storefront product JSON exposes only `available`, a
 * boolean — the theme cannot tell 1 unit from 20, and this rule turns on the
 * difference.
 */
async function loadSetStock(pool: Pool, matrixIds: string[]) {
  const r = await pool.query<{
    gid: string; pid: string | null; colour: string | null; size: string | null; qty: number;
  }>(
    `SELECT m.set_group_id::text AS gid,
            m.shopify_product_id AS pid,
            cs.color_code AS colour,
            cs.size,
            COUNT(i.id) FILTER (WHERE i.status = 'in-stock')::int AS qty
       FROM matrices m
       JOIN custom_skus cs ON cs.matrix_id = m.id AND NOT cs.archived
       LEFT JOIN items i ON i.custom_sku_id = cs.id
      WHERE m.set_group_id IN (
              SELECT set_group_id FROM matrices
               WHERE id = ANY($1::uuid[]) AND set_group_id IS NOT NULL)
      GROUP BY m.set_group_id, m.shopify_product_id, cs.color_code, cs.size`,
    [matrixIds],
  );
  /* productId -> "COLOUR|SIZE" -> units */
  const byProduct = new Map<string, Map<string, number>>();
  for (const row of r.rows) {
    if (!row.pid) continue;
    const key = `${String(row.colour || "").trim().toUpperCase()}|${String(row.size || "").trim().toUpperCase()}`;
    if (!byProduct.has(row.pid)) byProduct.set(row.pid, new Map());
    const m = byProduct.get(row.pid)!;
    m.set(key, (m.get(key) || 0) + row.qty);
  }
  return byProduct;
}

/**
 * Which partner units can be offered as a substitute size without breaking a
 * different set.
 *
 * If a shopper picks a top in M and there is no matching bottom in M, offering
 * them the L bottom would strand the L top — one complete set destroyed to
 * rescue another. So only SURPLUS units are offered: those a partner holds
 * beyond what its own same-size counterpart needs. Those are genuinely
 * individual pieces, and selling one breaks nothing.
 */
function surplusFor(
  mine: Map<string, number> | undefined,
  theirs: Map<string, number> | undefined,
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!theirs) return out;
  for (const [key, qty] of theirs) {
    const needed = mine?.get(key) ?? 0;
    const spare = qty - needed;
    if (spare > 0) out[key] = spare;
  }
  return out;
}

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
  const partnerMap = await loadPartners(pool, matrixIds);
  /* One batched lookup rather than a call per product: a set group's partners
     repeat across its members. */
  const handleMap = await loadHandles(
    ctx,
    [...new Set([...partnerMap.values()].flat())],
  );
  const stock = await loadSetStock(pool, matrixIds);
  const out: SetBannerResult[] = [];

  for (const row of rows) {
    const productId = row.shopify_product_id;
    if (!productId) {
      /* Not on Shopify yet — nothing to write. The banner lands when it is
         published, because publishing runs this too. */
      out.push({ matrixId: row.id, productId: null, picture: null, changed: false });
      continue;
    }

    /*
     * Which notice, and what the storefront needs to pair the product.
     *
     * A product named "… Set" whose partner is not listed cannot be paired, and
     * showing it the Complete the Look artwork would promise an automatic
     * pairing that cannot happen — so it gets the plain "sold individually"
     * wording instead. That distinction is the difference between a helpful
     * page and a misleading one.
     */
    const partnerIds = row.is_set ? (partnerMap.get(row.id) ?? []) : [];
    const sellablePartners = partnerIds
      .map((pid) => handleMap.get(pid))
      .filter((h): h is string => Boolean(h));

    /* Partner sizes that can stand in without stranding another set. */
    const surplus: Record<string, Record<string, number>> = {};
    for (const pid of partnerIds) {
      const handle = handleMap.get(pid);
      if (!handle) continue;
      surplus[handle] = surplusFor(stock.get(productId), stock.get(pid));
    }
    const picture = row.is_set ? pictureForProduct(row.skus || [], row.upc) : null;
    const mode: SetPicture | "solo" | null = !row.is_set
      ? null
      : sellablePartners.length
        ? picture
        : "solo";

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
      const nextHtml = applySetNoticeFor(currentHtml, mode);
      if (nextHtml === currentHtml) {
        /* Description already right, but the partner list can still have moved —
           a partner being published or unlisted changes pairing without changing
           a word of the copy. */
        await runShopifyGraphql({
          shop: ctx.shop,
          token: ctx.token,
          apiVersion: ctx.apiVersion,
          query: `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
          variables: {
            m: [
              {
                ownerId: productId,
                namespace: "carbon_set",
                key: "partners",
                type: "list.single_line_text_field",
                value: JSON.stringify(sellablePartners),
              },
              {
                ownerId: productId,
                namespace: "carbon_set",
                key: "surplus",
                type: "json",
                value: JSON.stringify(surplus),
              },
            ],
          },
        });
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
      /* The theme reads this to know what to pair with. Written after the
         description so a product never advertises a partner it is not also
         describing. An empty list is written deliberately when a product stops
         being a set, so the theme stops pairing it. */
      await runShopifyGraphql<{ metafieldsSet?: { userErrors?: Array<{ message: string }> } }>({
        shop: ctx.shop,
        token: ctx.token,
        apiVersion: ctx.apiVersion,
        query: `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
        variables: {
          m: [
            {
              ownerId: productId,
              namespace: "carbon_set",
              key: "partners",
              type: "list.single_line_text_field",
              value: JSON.stringify(sellablePartners),
            },
            {
              ownerId: productId,
              namespace: "carbon_set",
              key: "surplus",
              type: "json",
              value: JSON.stringify(surplus),
            },
          ],
        },
      });

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

/**
 * Refresh only the spare-stock figures for every set product.
 *
 * The surplus counts are a snapshot of WMS stock, so they drift as items sell —
 * and a stale figure is the one thing that could still break a set, by offering
 * a substitute whose spare unit has already gone. This rewrites the numbers
 * without touching descriptions, so it is cheap enough to run on the back of
 * every inventory sync: one Shopify call per set product, and nothing else on
 * the page is disturbed.
 */
export async function refreshSetSurplus(
  pool: Pool,
  ctx: ShopCtx,
): Promise<{ updated: number; failed: number }> {
  const r = await pool.query<{ id: string }>(
    `SELECT id::text AS id FROM matrices
      WHERE is_set = true AND set_group_id IS NOT NULL AND shopify_product_id IS NOT NULL`,
  );
  const ids = r.rows.map((x) => x.id);
  if (!ids.length) return { updated: 0, failed: 0 };

  const rows = await loadMatrixSetInfo(pool, ids);
  const partnerMap = await loadPartners(pool, ids);
  const handleMap = await loadHandles(ctx, [...new Set([...partnerMap.values()].flat())]);
  const stock = await loadSetStock(pool, ids);

  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    const productId = row.shopify_product_id;
    if (!productId) continue;
    const surplus: Record<string, Record<string, number>> = {};
    for (const pid of partnerMap.get(row.id) ?? []) {
      const handle = handleMap.get(pid);
      if (!handle) continue;
      surplus[handle] = surplusFor(stock.get(productId), stock.get(pid));
    }
    try {
      const res = await runShopifyGraphql<{ metafieldsSet?: { userErrors?: Array<{ message: string }> } }>({
        shop: ctx.shop,
        token: ctx.token,
        apiVersion: ctx.apiVersion,
        query: `mutation($m:[MetafieldsSetInput!]!){ metafieldsSet(metafields:$m){ userErrors{ field message } } }`,
        variables: {
          m: [{
            ownerId: productId,
            namespace: "carbon_set",
            key: "surplus",
            type: "json",
            value: JSON.stringify(surplus),
          }],
        },
      });
      if (!res.ok || (res.data?.metafieldsSet?.userErrors || []).length) failed += 1;
      else updated += 1;
    } catch {
      failed += 1;
    }
  }
  return { updated, failed };
}
