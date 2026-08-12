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

/** Turn on "track quantity" for an inventory item (required to control qty). */
export async function enableInventoryTracking(
  ctx: ShopCtx,
  inventoryItemId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await gql<{ inventoryItemUpdate?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation inventoryItemUpdate($id: ID!, $input: InventoryItemInput!) {
      inventoryItemUpdate(id: $id, input: $input) { userErrors { message } }
    }`,
    { id: inventoryItemId, input: { tracked: true } },
  );
  const errs = res.data?.inventoryItemUpdate?.userErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

/** Activate an inventory item at a location (so quantities can be set there). */
export async function activateInventory(
  ctx: ShopCtx,
  inventoryItemId: string,
  locationId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await gql<{ inventoryActivate?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
      inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
        userErrors { message }
      }
    }`,
    { inventoryItemId, locationId },
  );
  const errs = res.data?.inventoryActivate?.userErrors || [];
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

// ── Media (images) ─────────────────────────────────────────────────────────
// Uses Shopify STAGED UPLOADS: PUT the bytes to a temporary Shopify target,
// then productCreateMedia from the returned resourceUrl. No external storage
// (no R2) and nothing is kept locally — Shopify hosts the final CDN image.

type StagedTarget = { url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> };

/** Stage bytes on Shopify's temporary target; returns the resourceUrl to hand
 * to productCreateMedia. Uploads via multipart POST (httpMethod POST). */
export async function stageImageUpload(
  ctx: ShopCtx,
  filename: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<{ ok: true; resourceUrl: string } | { ok: false; error: string }> {
  const res = await gql<{
    stagedUploadsCreate?: {
      stagedTargets?: StagedTarget[];
      userErrors?: Array<{ message: string }>;
    };
  }>(
    ctx,
    `mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets { url resourceUrl parameters { name value } }
        userErrors { field message }
      }
    }`,
    {
      input: [
        {
          filename,
          mimeType,
          resource: "IMAGE",
          httpMethod: "POST",
          fileSize: String(bytes.byteLength),
        },
      ],
    },
  );
  const errs = res.data?.stagedUploadsCreate?.userErrors || [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; ") };
  const target = res.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    return { ok: false, error: "stagedUploadsCreate returned no target" };
  }
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append("file", new Blob([bytes as unknown as BlobPart], { type: mimeType }), filename);
  const put = await fetch(target.url, { method: "POST", body: form });
  if (!put.ok) {
    return { ok: false, error: `staged upload PUT failed: HTTP ${put.status}` };
  }
  return { ok: true, resourceUrl: target.resourceUrl };
}

/** Create product media from a source URL/resourceUrl, then poll until the
 * image is READY and return its Shopify CDN url + media id. */
export async function createProductMedia(
  ctx: ShopCtx,
  productId: string,
  source: string,
  alt: string,
): Promise<{ ok: true; mediaId: string; imageUrl: string } | { ok: false; error: string }> {
  const create = await gql<{
    productCreateMedia?: {
      media?: Array<{ id: string; status?: string; image?: { url?: string } }>;
      mediaUserErrors?: Array<{ message: string }>;
    };
  }>(
    ctx,
    `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media { ... on MediaImage { id status image { url } } }
        mediaUserErrors { field message }
      }
    }`,
    {
      productId: toProductGid(productId),
      media: [{ mediaContentType: "IMAGE", originalSource: source, alt }],
    },
  );
  const errs = create.data?.productCreateMedia?.mediaUserErrors || [];
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; ") };
  const media = create.data?.productCreateMedia?.media?.[0];
  if (!media?.id) return { ok: false, error: "productCreateMedia returned no media" };

  // Poll until READY (Shopify ingests the image asynchronously).
  for (let i = 0; i < 20; i++) {
    const q = await gql<{
      node?: { id: string; status?: string; image?: { url?: string } };
    }>(
      ctx,
      `query($id: ID!) { node(id: $id) { ... on MediaImage { id status image { url } } } }`,
      { id: media.id },
    );
    const n = q.data?.node;
    if (n?.status === "READY" && n.image?.url) {
      return { ok: true, mediaId: media.id, imageUrl: n.image.url };
    }
    if (n?.status === "FAILED") return { ok: false, error: "media processing FAILED" };
    await new Promise((r) => setTimeout(r, 800));
  }
  return { ok: false, error: "media not READY after timeout" };
}

export type ProductMedia = { id: string; url: string; alt: string };

/** List a product's IMAGE media (id, url, alt) in current order. */
export async function listProductMedia(ctx: ShopCtx, productId: string): Promise<ProductMedia[]> {
  const res = await gql<{
    product?: {
      media?: { nodes?: Array<{ id: string; mediaContentType?: string; image?: { url?: string; altText?: string | null } }> };
    };
  }>(
    ctx,
    `query($id: ID!) {
      product(id: $id) {
        media(first: 250) { nodes { ... on MediaImage { id image { url altText } } mediaContentType } }
      }
    }`,
    { id: toProductGid(productId) },
  );
  return (res.data?.product?.media?.nodes || [])
    .filter((n) => String(n.mediaContentType || "").toUpperCase() === "IMAGE" && n.id)
    .map((n) => ({ id: n.id, url: n.image?.url || "", alt: n.image?.altText || "" }));
}

/** Delete product media (removes the images from Shopify). */
export async function deleteProductMedia(
  ctx: ShopCtx,
  productId: string,
  mediaIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (!mediaIds.length) return { ok: true };
  const res = await gql<{ productDeleteMedia?: { mediaUserErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation productDeleteMedia($productId: ID!, $mediaIds: [ID!]!) {
      productDeleteMedia(productId: $productId, mediaIds: $mediaIds) { deletedMediaIds mediaUserErrors { field message } }
    }`,
    { productId: toProductGid(productId), mediaIds },
  );
  const errs = res.data?.productDeleteMedia?.mediaUserErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

/** Set alt text on existing media. */
export async function updateMediaAlt(
  ctx: ShopCtx,
  productId: string,
  items: Array<{ id: string; alt: string }>,
): Promise<{ ok: boolean; error?: string }> {
  if (!items.length) return { ok: true };
  const res = await gql<{ productUpdateMedia?: { mediaUserErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation productUpdateMedia($productId: ID!, $media: [UpdateMediaInput!]!) {
      productUpdateMedia(productId: $productId, media: $media) { mediaUserErrors { field message } }
    }`,
    { productId: toProductGid(productId), media: items.map((i) => ({ id: i.id, alt: i.alt || null })) },
  );
  const errs = res.data?.productUpdateMedia?.mediaUserErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

/** Reorder media to the given order (index 0 = hero / first). */
export async function reorderProductMedia(
  ctx: ShopCtx,
  productId: string,
  orderedMediaIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  if (orderedMediaIds.length < 2) return { ok: true };
  const moves = orderedMediaIds.map((id, idx) => ({ id, newPosition: String(idx + 1) }));
  const res = await gql<{ productReorderMedia?: { userErrors?: Array<{ message: string }>; mediaUserErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation productReorderMedia($id: ID!, $moves: [MoveInput!]!) {
      productReorderMedia(id: $id, moves: $moves) { mediaUserErrors { field message } userErrors { field message } }
    }`,
    { id: toProductGid(productId), moves },
  );
  const errs = [
    ...(res.data?.productReorderMedia?.mediaUserErrors || []),
    ...(res.data?.productReorderMedia?.userErrors || []),
  ];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

/** Attach existing product media to a specific variant (per-colour image). */
export async function appendMediaToVariant(
  ctx: ShopCtx,
  productId: string,
  variantId: string,
  mediaId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await gql<{ productVariantAppendMedia?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation productVariantAppendMedia($productId: ID!, $variantMedia: [ProductVariantAppendMediaInput!]!) {
      productVariantAppendMedia(productId: $productId, variantMedia: $variantMedia) {
        userErrors { field message }
      }
    }`,
    {
      productId: toProductGid(productId),
      variantMedia: [{ variantId, mediaIds: [mediaId] }],
    },
  );
  const errs = res.data?.productVariantAppendMedia?.userErrors || [];
  return errs.length ? { ok: false, error: errs.map((e) => e.message).join("; ") } : { ok: true };
}

export type MetafieldInput = {
  ownerId: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
};

/** metafieldsSet in batches of 25 (Shopify's per-call limit). */
export async function setMetafields(
  ctx: ShopCtx,
  metafields: MetafieldInput[],
): Promise<{ ok: boolean; error?: string }> {
  const errors: string[] = [];
  for (let i = 0; i < metafields.length; i += 25) {
    const batch = metafields.slice(i, i + 25);
    const res = await gql<{ metafieldsSet?: { userErrors?: Array<{ message: string }> } }>(
      ctx,
      `mutation metafieldsSet($m: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $m) { userErrors { field message } }
      }`,
      { m: batch },
    );
    const errs = res.data?.metafieldsSet?.userErrors || [];
    if (!res.ok) errors.push(JSON.stringify(res.errors));
    else if (errs.length) errors.push(...errs.map((e) => e.message));
  }
  return errors.length ? { ok: false, error: errors.join("; ") } : { ok: true };
}

/** Create a manual Shopify collection (M4). */
export async function collectionCreate(
  ctx: ShopCtx,
  input: { title: string; descriptionHtml?: string },
): Promise<{ ok: true; id: string; handle: string } | { ok: false; error: string }> {
  const res = await gql<{
    collectionCreate?: {
      collection?: { id: string; handle: string };
      userErrors?: Array<{ message: string }>;
    };
  }>(
    ctx,
    `mutation collectionCreate($input: CollectionInput!) {
      collectionCreate(input: $input) {
        collection { id handle }
        userErrors { field message }
      }
    }`,
    { input: { title: input.title, ...(input.descriptionHtml ? { descriptionHtml: input.descriptionHtml } : {}) } },
  );
  const errs = res.data?.collectionCreate?.userErrors || [];
  if (!res.ok) return { ok: false, error: JSON.stringify(res.errors) };
  if (errs.length) return { ok: false, error: errs.map((e) => e.message).join("; ") };
  const c = res.data?.collectionCreate?.collection;
  if (!c?.id) return { ok: false, error: "collectionCreate returned no collection" };
  return { ok: true, id: c.id, handle: c.handle };
}

/** Delete a collection (used only to clean up verification/test collections). */
export async function collectionDelete(
  ctx: ShopCtx,
  collectionId: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await gql<{ collectionDelete?: { userErrors?: Array<{ message: string }> } }>(
    ctx,
    `mutation collectionDelete($input: CollectionDeleteInput!) {
      collectionDelete(input: $input) { deletedCollectionId userErrors { field message } }
    }`,
    { input: { id: collectionId } },
  );
  const errs = res.data?.collectionDelete?.userErrors || [];
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
