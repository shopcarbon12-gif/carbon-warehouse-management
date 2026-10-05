/**
 * Shopify → WMS "Sales": the store's orders, read live from the Admin API.
 *
 * Read on every request rather than copied into Postgres: the page is meant to
 * look exactly like Shopify's own Orders page, and a copy would drift the first
 * time a webhook was missed. Nothing here writes to Shopify.
 *
 * Limits worth knowing:
 *  - Without the `read_all_orders` scope Shopify returns only the last 60 days
 *    of orders. The token was granted it on 2026-10-05 (74 orders, from #1001);
 *    if the list ever shrinks to two months, that scope has been lost.
 *  - Customer names come back because the token has `read_customers`.
 */
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext, type ShopCtx } from "@/lib/server/shopify-write";

export const SALES_TABS = ["all", "unfulfilled", "unpaid", "open", "archived"] as const;
export type SalesTab = (typeof SALES_TABS)[number];

/** The same filters Shopify's own tabs apply, in its search syntax. */
const TAB_QUERY: Record<SalesTab, string> = {
  all: "",
  unfulfilled: "fulfillment_status:unfulfilled OR fulfillment_status:partial",
  unpaid: "financial_status:pending OR financial_status:authorized OR financial_status:partially_paid OR financial_status:expired",
  open: "status:open",
  archived: "status:closed",
};

export const SALES_PAGE_SIZE = 50;

type Money = { amount: string; currencyCode: string };

export type SaleRow = {
  id: string;
  legacyId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  test: boolean;
  customer: string | null;
  channel: string | null;
  total: Money | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  returnStatus: string | null;
  items: number;
  deliveryStatus: string | null;
  deliveryMethod: string | null;
  tags: string[];
};

export type SalesPage = {
  rows: SaleRow[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  count: number | null;
  countIsExact: boolean;
  /** Admin URL base, e.g. https://abc123.myshopify.com/admin */
  adminBase: string;
};

const ROW_FIELDS = `
  id legacyResourceId name createdAt cancelledAt closed test
  displayFinancialStatus displayFulfillmentStatus returnStatus
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  customer { displayName }
  channelInformation { channelDefinition { channelName } }
  app { name }
  currentSubtotalLineItemsQuantity requiresShipping
  tags
  shippingLines(first: 1) { nodes { title } }
  fulfillments(first: 5) { displayStatus createdAt }
`;

type RawOrder = {
  id: string;
  legacyResourceId: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  closed: boolean;
  test: boolean;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  returnStatus: string | null;
  currentTotalPriceSet: { shopMoney: Money } | null;
  customer: { displayName: string } | null;
  channelInformation: { channelDefinition: { channelName: string } | null } | null;
  app: { name: string } | null;
  currentSubtotalLineItemsQuantity: number;
  requiresShipping: boolean;
  tags: string[];
  shippingLines: { nodes: Array<{ title: string }> };
  fulfillments: Array<{ displayStatus: string | null; createdAt: string }>;
};

function toRow(o: RawOrder): SaleRow {
  // The newest fulfilment's tracking state is what Shopify shows as "Delivery status".
  const latest = [...(o.fulfillments ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return {
    id: o.id,
    legacyId: o.legacyResourceId,
    name: o.name,
    createdAt: o.createdAt,
    cancelledAt: o.cancelledAt,
    closed: o.closed,
    test: o.test,
    customer: o.customer?.displayName ?? null,
    channel: o.channelInformation?.channelDefinition?.channelName ?? o.app?.name ?? null,
    total: o.currentTotalPriceSet?.shopMoney ?? null,
    financialStatus: o.displayFinancialStatus,
    /* Shopify's list says "Not required" for an order with nothing left to
       ship — refunded or cancelled down to 0 items — while the API still says
       UNFULFILLED. Showed as yellow "Unfulfilled" before; it is not work. */
    fulfillmentStatus:
      o.displayFulfillmentStatus === "UNFULFILLED" && ((o.currentSubtotalLineItemsQuantity ?? 0) === 0 || o.requiresShipping === false)
        ? "NOT_REQUIRED"
        : o.displayFulfillmentStatus,
    returnStatus: o.returnStatus,
    items: o.currentSubtotalLineItemsQuantity ?? 0,
    deliveryStatus: latest?.displayStatus ?? null,
    deliveryMethod: o.shippingLines?.nodes?.[0]?.title ?? (o.requiresShipping === false ? "Shipping not required" : "Shipping"),
    tags: o.tags ?? [],
  };
}

/**
 * Links into the Shopify admin go through the shop's own myshopify address,
 * which signs in and forwards to admin.shopify.com/store/<handle>. Building
 * admin.shopify.com/store/<id> directly broke: the store's admin handle
 * ("shopcarbon1") is not its myshopify id ("30e7d3"), and that URL is a 403.
 */
export function adminBaseFor(shop: string): string {
  return `https://${shop}/admin`;
}

export class ShopifyNotConnected extends Error {}

async function ctxOrThrow(): Promise<ShopCtx> {
  const ctx = await resolveShopContext();
  if (!ctx) throw new ShopifyNotConnected("Shopify is not connected (no shop domain or access token).");
  return ctx;
}

function gqlError(errors: unknown): Error {
  const first = Array.isArray(errors) ? (errors[0] as { message?: string } | undefined)?.message : undefined;
  return new Error(first || "Shopify returned an error.");
}

export async function listSales(opts: {
  tab: SalesTab;
  search?: string;
  after?: string | null;
  before?: string | null;
}): Promise<SalesPage> {
  const ctx = await ctxOrThrow();
  const parts = [TAB_QUERY[opts.tab], (opts.search ?? "").trim()].filter(Boolean);
  const q = parts.length > 1 ? parts.map((p) => `(${p})`).join(" AND ") : parts[0] ?? null;
  // Shopify rejects a declared variable that the query does not use.
  const back = !!opts.before;
  const paging = back ? `last: ${SALES_PAGE_SIZE}, before: $cursor` : `first: ${SALES_PAGE_SIZE}, after: $cursor`;
  const query = `query Sales($q: String, $cursor: String) {
    ordersCount(query: $q) { count precision }
    orders(${paging}, sortKey: CREATED_AT, reverse: true, query: $q) {
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      nodes { ${ROW_FIELDS} }
    }
  }`;
  const r = await runShopifyGraphql<{
    ordersCount: { count: number; precision: string } | null;
    orders: { pageInfo: SalesPage["pageInfo"]; nodes: RawOrder[] };
  }>({
    shop: ctx.shop,
    token: ctx.token,
    apiVersion: ctx.apiVersion,
    query,
    variables: { q, cursor: (back ? opts.before : opts.after) ?? null },
  });
  if (!r.ok || !r.data) throw gqlError(r.errors);
  return {
    rows: r.data.orders.nodes.map(toRow),
    pageInfo: r.data.orders.pageInfo,
    count: r.data.ordersCount?.count ?? null,
    countIsExact: r.data.ordersCount?.precision === "EXACT",
    adminBase: adminBaseFor(ctx.shop),
  };
}

/** Shopify's "Today" bar: orders, items ordered, returns, fulfilled, delivered. */
export async function salesToday(tz: string): Promise<{
  orders: number;
  items: number;
  returns: number;
  fulfilled: number;
  delivered: number;
}> {
  const ctx = await ctxOrThrow();
  // Midnight in the shop owner's time zone, as an ISO instant.
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offsetMs = now.getTime() - local.getTime();
  const midnight = new Date(local.getFullYear(), local.getMonth(), local.getDate()).getTime() + offsetMs;
  const since = new Date(midnight).toISOString();
  const query = `query Today($q: String) {
    orders(first: 250, query: $q) {
      nodes { currentSubtotalLineItemsQuantity returnStatus displayFulfillmentStatus fulfillments(first: 5) { displayStatus } }
    }
  }`;
  const r = await runShopifyGraphql<{
    orders: { nodes: Array<{ currentSubtotalLineItemsQuantity: number; returnStatus: string; displayFulfillmentStatus: string; fulfillments: Array<{ displayStatus: string | null }> }> };
  }>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables: { q: `created_at:>='${since}'` } });
  if (!r.ok || !r.data) throw gqlError(r.errors);
  const n = r.data.orders.nodes;
  return {
    orders: n.length,
    items: n.reduce((s, o) => s + (o.currentSubtotalLineItemsQuantity ?? 0), 0),
    returns: n.filter((o) => o.returnStatus && o.returnStatus !== "NO_RETURN").length,
    fulfilled: n.filter((o) => o.displayFulfillmentStatus === "FULFILLED").length,
    delivered: n.filter((o) => o.fulfillments?.some((f) => f.displayStatus === "DELIVERED")).length,
  };
}

/* ─────────────────────────────── one order ─────────────────────────────── */

export type SaleDetail = SaleRow & {
  email: string | null;
  phone: string | null;
  note: string | null;
  customerOrders: string | null;
  shippingAddress: string[];
  billingAddress: string[];
  subtotal: Money | null;
  shipping: Money | null;
  tax: Money | null;
  discounts: Money | null;
  refunded: Money | null;
  lines: Array<{
    title: string;
    variant: string | null;
    sku: string | null;
    variantId: string | null;
    quantity: number;
    unit: Money | null;
    total: Money | null;
    image: string | null;
  }>;
  tracking: Array<{ company: string | null; number: string | null; url: string | null; status: string | null }>;
  adminUrl: string;
};

export async function getSale(id: string): Promise<SaleDetail | null> {
  const ctx = await ctxOrThrow();
  const gid = id.startsWith("gid://") ? id : `gid://shopify/Order/${id.replace(/\D/g, "")}`;
  const query = `query Sale($id: ID!) {
    order(id: $id) {
      ${ROW_FIELDS}
      email phone note
      customer { displayName numberOfOrders }
      shippingAddress { formatted(withName: true) }
      billingAddress { formatted(withName: true) }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      totalShippingPriceSet { shopMoney { amount currencyCode } }
      totalTaxSet { shopMoney { amount currencyCode } }
      totalDiscountsSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      lineItems(first: 100) {
        nodes {
          title variantTitle sku currentQuantity variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
          discountedTotalSet { shopMoney { amount currencyCode } }
          image { url(transform: { maxWidth: 120, maxHeight: 120 }) }
        }
      }
      allFulfillments: fulfillments(first: 10) { displayStatus trackingInfo(first: 5) { company number url } }
    }
  }`;
  type M = { shopMoney: Money } | null;
  const r = await runShopifyGraphql<{
    order:
      | (RawOrder & {
          email: string | null;
          phone: string | null;
          note: string | null;
          customer: { displayName: string; numberOfOrders: string } | null;
          shippingAddress: { formatted: string[] } | null;
          billingAddress: { formatted: string[] } | null;
          subtotalPriceSet: M;
          totalShippingPriceSet: M;
          totalTaxSet: M;
          totalDiscountsSet: M;
          totalRefundedSet: M;
          lineItems: {
            nodes: Array<{
              title: string;
              variantTitle: string | null;
              sku: string | null;
              currentQuantity: number;
              variant: { id: string } | null;
              originalUnitPriceSet: M;
              discountedTotalSet: M;
              image: { url: string } | null;
            }>;
          };
          allFulfillments: Array<{ displayStatus: string | null; trackingInfo: Array<{ company: string | null; number: string | null; url: string | null }> }>;
        })
      | null;
  }>({ shop: ctx.shop, token: ctx.token, apiVersion: ctx.apiVersion, query, variables: { id: gid } });
  if (!r.ok) throw gqlError(r.errors);
  const o = r.data?.order;
  if (!o) return null;
  const m = (x: M) => x?.shopMoney ?? null;
  return {
    ...toRow(o),
    email: o.email,
    phone: o.phone,
    note: o.note,
    customerOrders: o.customer?.numberOfOrders ?? null,
    shippingAddress: o.shippingAddress?.formatted ?? [],
    billingAddress: o.billingAddress?.formatted ?? [],
    subtotal: m(o.subtotalPriceSet),
    shipping: m(o.totalShippingPriceSet),
    tax: m(o.totalTaxSet),
    discounts: m(o.totalDiscountsSet),
    refunded: m(o.totalRefundedSet),
    lines: o.lineItems.nodes.map((l) => ({
      title: l.title,
      variant: l.variantTitle,
      sku: l.sku,
      variantId: l.variant?.id ?? null,
      quantity: l.currentQuantity,
      unit: m(l.originalUnitPriceSet),
      total: m(l.discountedTotalSet),
      image: l.image?.url ?? null,
    })),
    tracking: o.allFulfillments.flatMap((f) =>
      f.trackingInfo.map((t) => ({ company: t.company, number: t.number, url: t.url, status: f.displayStatus })),
    ),
    adminUrl: `${adminBaseFor(ctx.shop)}/orders/${o.legacyResourceId}`,
  };
}

/** An order still to fulfil, for the home-screen notice. */
export type ToFulfillOrder = {
  legacyId: string;
  name: string;
  createdAt: string;
  customer: string | null;
  total: Money | null;
  items: number;
};

/**
 * The number on Shopify's "Orders" menu item — open orders that still have
 * something to fulfil — and the newest of them. Same filter as Shopify's,
 * checked against the admin on 2026-10-05 (both said 1, order #1076).
 */
export async function toFulfill(): Promise<{ count: number; orders: ToFulfillOrder[] }> {
  const ctx = await ctxOrThrow();
  const r = await runShopifyGraphql<{
    ordersCount: { count: number } | null;
    orders: { nodes: Array<{ legacyResourceId: string; name: string; createdAt: string; customer: { displayName: string } | null; currentTotalPriceSet: { shopMoney: Money } | null; currentSubtotalLineItemsQuantity: number }> };
  }>({
    shop: ctx.shop,
    token: ctx.token,
    apiVersion: ctx.apiVersion,
    query: `query ToFulfill($q: String) {
      ordersCount(query: $q) { count }
      orders(first: 10, sortKey: CREATED_AT, reverse: true, query: $q) {
        nodes { legacyResourceId name createdAt customer { displayName } currentTotalPriceSet { shopMoney { amount currencyCode } } currentSubtotalLineItemsQuantity }
      }
    }`,
    variables: { q: "status:open AND (fulfillment_status:unfulfilled OR fulfillment_status:partial)" },
  });
  if (!r.ok || !r.data) throw gqlError(r.errors);
  return {
    count: r.data.ordersCount?.count ?? 0,
    orders: r.data.orders.nodes.map((o) => ({
      legacyId: o.legacyResourceId,
      name: o.name,
      createdAt: o.createdAt,
      customer: o.customer?.displayName ?? null,
      total: o.currentTotalPriceSet?.shopMoney ?? null,
      items: o.currentSubtotalLineItemsQuantity ?? 0,
    })),
  };
}
