/**
 * Shopify WRITE layer for WMS→Shopify product publishing (M1).
 *
 * Uses the modern `productSet` mutation as the create+update primitive — it is
 * idempotent (keyed on the product id when re-publishing) and reconciles the
 * variant set to exactly what we declare, so WMS matrices that are *sparse*
 * (not every colour×size exists) don't leave junk cartesian variants behind.
 * Inventory, publication, and cleanup use the standard Admin mutations.
 *
 * One shop/token/version context is resolved from env
 * (SHOPIFY_SHOP_DOMAIN + SHOPIFY_ADMIN_ACCESS_TOKEN), falling back to the DB
 * token store. Orchestration lives in lib/server/shopify-publish.ts.
 */
import {
  getShopifyAdminToken,
  normalizeShopDomain,
  runShopifyGraphql,
  toProductGid,
} from "@/lib/shopify";
import { getShopifyAccessToken } from "@/lib/shopifyTokenRepository";

export type ShopCtx = { shop: string; token: string; apiVersion: string };

export async function resolveShopContext(): Promise<ShopCtx | null> {
  const shop = normalizeShopDomain(process.env.SHOPIFY_SHOP_DOMAIN || "") || "";
  if (!shop) return null;
  let token = getShopifyAdminToken(shop);
  if (!token) {
    try {
      token = (await getShopifyAccessToken(shop)) || "";
    } catch {
      token = "";
    }
  }
  if (!token) return null;
  const apiVersion = (process.env.SHOPIFY_API_VERSION || "").trim() || "2025-01";
  return { shop, token, apiVersion };
}

type Gql<T> = { ok: boolean; data?: T | null; errors?: unknown };

async function gql<T>(
  ctx: ShopCtx,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Gql<T>> {
  return (await runShopifyGraphql<T>({
    shop: ctx.shop,
    token: ctx.token,
    query,
    variables,
    apiVersion: ctx.apiVersion,
  })) as Gql<T>;
}

export type SelectedOption = { name: string; value: string };
export type ShopVariant = {
  id: string;
  sku: string | null;
  selectedOptions: SelectedOption[];
  inventoryItem?: { id: string } | null;
};
const VARIANT_FIELDS = `id sku selectedOptions { name value } inventoryItem { id }`;

export type SetVariant = {
  optionValues: Array<{ optionName: string; name: string }>;
  sku: string;
  price?: string;
  compareAtPrice?: string;
  barcode?: string;
};

const PRODUCT_SET = `mutation productSet($input: ProductSetInput!) {
  productSet(synchronous: true, input: $input) {
    product { id variants(first: 250) { nodes { ${VARIANT_FIELDS} } } }
    userErrors { field message }
  }
}`;

type ProductSetData = {
  productSet?: {
    product?: { id: string; variants?: { nodes?: ShopVariant[] } };
    userErrors?: Array<{ field?: string[]; message: string }>;
  };
};

/**
 * Create or update a Shopify product (pass `productId` to update). Declares the
 * full option + variant set; Shopify reconciles. Retries once with a unique
 * handle on a handle collision (create only).
 */
export async function productSet(
  ctx: ShopCtx,
  input: {
    productId?: string | null;
    title: string;
    vendor?: string;
    productType?: string;
    handle?: string;
    options: Array<{ name: string; values: string[] }>;
    variants: SetVariant[];
  },
): Promise<
  | { ok: true; productId: string; variants: ShopVariant[] }
  | { ok: false; error: string }
> {
  const build = (handle?: string): Record<string, unknown> => {
    const p: Record<string, unknown> = {
      title: input.title,
      status: "ACTIVE",
      productOptions: input.options.map((o) => ({
        name: o.name,
        values: o.values.map((v) => ({ name: v })),
      })),
      variants: input.variants.map((v) => ({
        optionValues: v.optionValues,
        ...(v.price != null ? { price: v.price } : {}),
        ...(v.compareAtPrice != null ? { compareAtPrice: v.compareAtPrice } : {}),
        ...(v.barcode ? { barcode: v.barcode } : {}),
        inventoryItem: { sku: v.sku, tracked: true },
      })),
    };
    if (input.productId) p.id = toProductGid(input.productId);
    if (input.vendor) p.vendor = input.vendor;
    if (input.productType) p.productType = input.productType;
    if (handle && !input.productId) p.handle = handle;
    return p;
  };

  const call = (handle?: string) =>
    gql<ProductSetData>(ctx, PRODUCT_SET, { input: build(handle) });

  let res = await call(input.handle);
  let errs = res.data?.productSet?.userErrors || [];
  const handleClash =
    errs.some((e) => /handle.*(already|in use)|already.*in use/i.test(e.message)) &&
    input.handle &&
    !input.productId;
  if (!res.ok || (errs.length && handleClash)) {
    if (handleClash) {
      res = await call(`${(input.handle || "").slice(0, 240)}-${Date.now().toString(36)}`);
      errs = res.data?.productSet?.userErrors || [];
    }
  }
  if (!res.ok) return { ok: false, error: JSON.stringify(res.errors) };
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; ") };
  const p = res.data?.productSet?.product;
  if (!p?.id) return { ok: false, error: "productSet returned no product" };
  return { ok: true, productId: p.id, variants: p.variants?.nodes || [] };
}

/** First active fulfillment location (WMS is single-location for now). */
export async function primaryLocationId(ctx: ShopCtx): Promise<string | null> {
  const res = await gql<{ locations?: { nodes?: Array<{ id: string; isActive: boolean }> } }>(
    ctx,
    `query { locations(first: 10) { nodes { id isActive } } }`,
  );
  const nodes = res.data?.locations?.nodes || [];
  return (nodes.find((n) => n.isActive) || nodes[0])?.id || null;
}

/** Set on-hand for an inventory item at a location (absolute quantity). */
export async function setInventoryQuantity(
  ctx: ShopCtx,
  inventoryItemId: string,
  locationId: string,
  quantity: number,
): Promise<{ ok: boolean; error?: string }> {
  const res = await gql<{ inventorySetQuantities?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
      inventorySetQuantities(input: $input) { userErrors { message } }
    }`,
    {
      input: {
        name: "available",
        reason: "correction",
        ignoreCompareQuantity: true,
        quantities: [
          { inventoryItemId, locationId, quantity: Math.max(0, Math.trunc(quantity)) },
        ],
      },
    },
  );
  const errs = res.data?.inventorySetQuantities?.userErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

/** Online Store publication id (for publishablePublish), if the channel exists. */
export async function onlineStorePublicationId(ctx: ShopCtx): Promise<string | null> {
  const res = await gql<{ publications?: { nodes?: Array<{ id: string; name: string }> } }>(
    ctx,
    `query { publications(first: 30) { nodes { id name } } }`,
  );
  const nodes = res.data?.publications?.nodes || [];
  return nodes.find((n) => /online store/i.test(n.name))?.id || null;
}

export async function publishToPublication(
  ctx: ShopCtx,
  productId: string,
  publicationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await gql<{ publishablePublish?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) { userErrors { message } }
    }`,
    { id: toProductGid(productId), input: [{ publicationId }] },
  );
  const errs = res.data?.publishablePublish?.userErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

/** Delete a product (used only to clean up verification/test products). */
export async function deleteProduct(
  ctx: ShopCtx,
  productId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await gql<{ productDelete?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation productDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) { deletedProductId userErrors { message } }
    }`,
    { input: { id: toProductGid(productId) } },
  );
  const errs = res.data?.productDelete?.userErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}
