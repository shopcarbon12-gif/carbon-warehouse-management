/**
 * "Needs attention" on the CarbonWMS home screen (owner 2026-11-08): every
 * open item that someone has to act on, next to the Shopify orders to fulfil —
 * not only as menu badges.
 *
 *  - Wholesale applications waiting for approve / decline (CarbonWMS DB).
 *  - Wholesale (B2B) orders paid but with no shipping charge yet → pack, then
 *    Edit order → add shipping fee → Send invoice.
 *  - Wholesale orders with a shipping invoice still unpaid; overdue after 24 h
 *    (owner's rule: unpaid within 24 hours → cancel, release the items).
 *  - Returns waiting (same source as the Returns menu count).
 *
 * Each part is read on its own: one failing leaves the others shown.
 */
import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { listOpenReturns } from "@/lib/server/shopify-return-desk";

export const INVOICE_DUE_HOURS = 24;

type Money = { amount: string; currencyCode: string };

export type AttentionOrder = {
  legacyId: string;
  name: string;
  company: string | null;
  createdAt: string;
  updatedAt: string;
  total: Money | null;
  outstanding: Money | null;
  /** Unpaid invoice older than INVOICE_DUE_HOURS. */
  overdue: boolean;
};

export type Attention = {
  applications: { count: number; items: Array<{ id: number; businessName: string; cityState: string; createdAt: string }> } | null;
  toInvoice: { count: number; items: AttentionOrder[] } | null;
  unpaidInvoices: { count: number; overdue: number; items: AttentionOrder[] } | null;
  returns: { count: number } | null;
  /** Total open items, for the box heading. */
  total: number;
  errors: string[];
};

async function applications(pool: Pool): Promise<Attention["applications"]> {
  const r = await pool.query<{ id: string; business_name: string; city_state: string; created_at: Date; n: string }>(
    `SELECT id, business_name, city_state, created_at, count(*) OVER () AS n
       FROM wholesale_applications WHERE status = 'new'
      ORDER BY created_at ASC LIMIT 8`,
  );
  return {
    count: Number(r.rows[0]?.n ?? 0),
    items: r.rows.map((x) => ({ id: Number(x.id), businessName: x.business_name, cityState: x.city_state, createdAt: x.created_at.toISOString() })),
  };
}

type OrderNode = {
  legacyResourceId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  cancelledAt: string | null;
  purchasingEntity: { __typename: string; company?: { name: string } } | null;
  totalShippingPriceSet: { shopMoney: Money } | null;
  totalOutstandingSet: { shopMoney: Money } | null;
  currentTotalPriceSet: { shopMoney: Money } | null;
};

async function wholesaleOrders(): Promise<{ toInvoice: AttentionOrder[]; unpaid: AttentionOrder[] }> {
  const ctx = await resolveShopContext();
  if (!ctx) throw new Error("Shopify is not connected");
  const r = await runShopifyGraphql<{ orders: { nodes: OrderNode[] } }>({
    shop: ctx.shop,
    token: ctx.token,
    apiVersion: ctx.apiVersion,
    query: `query WholesaleAttention($q: String) {
      orders(first: 100, sortKey: CREATED_AT, reverse: true, query: $q) {
        nodes {
          legacyResourceId name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus cancelledAt
          purchasingEntity { __typename ... on PurchasingCompany { company { name } } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          totalOutstandingSet { shopMoney { amount currencyCode } }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
        }
      }
    }`,
    variables: { q: `status:open created_at:>=${new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10)}` },
  });
  if (!r.ok || !r.data) throw new Error("Could not read wholesale orders from Shopify");
  const now = Date.now();
  const toInvoice: AttentionOrder[] = [];
  const unpaid: AttentionOrder[] = [];
  for (const o of r.data.orders.nodes) {
    if (o.cancelledAt || o.purchasingEntity?.__typename !== "PurchasingCompany") continue;
    const shipping = Number(o.totalShippingPriceSet?.shopMoney.amount ?? 0);
    const outstanding = Number(o.totalOutstandingSet?.shopMoney.amount ?? 0);
    const base: AttentionOrder = {
      legacyId: o.legacyResourceId,
      name: o.name,
      company: o.purchasingEntity.company?.name ?? null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      total: o.currentTotalPriceSet?.shopMoney ?? null,
      outstanding: o.totalOutstandingSet?.shopMoney ?? null,
      overdue: false,
    };
    if (outstanding > 0) {
      // The invoice is sent when the order is edited — its last update.
      base.overdue = now - new Date(o.updatedAt).getTime() > INVOICE_DUE_HOURS * 3_600_000;
      unpaid.push(base);
    } else if (shipping <= 0 && o.displayFulfillmentStatus !== "FULFILLED" && o.displayFinancialStatus === "PAID") {
      toInvoice.push(base);
    }
  }
  // Oldest first: they have waited longest.
  toInvoice.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  unpaid.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  return { toInvoice, unpaid };
}

export async function loadAttention(pool: Pool): Promise<Attention> {
  const errors: string[] = [];
  const [apps, orders, rets] = await Promise.allSettled([applications(pool), wholesaleOrders(), listOpenReturns(pool)]);
  const out: Attention = { applications: null, toInvoice: null, unpaidInvoices: null, returns: null, total: 0, errors };
  if (apps.status === "fulfilled") out.applications = apps.value;
  else errors.push("wholesale applications");
  if (orders.status === "fulfilled") {
    out.toInvoice = { count: orders.value.toInvoice.length, items: orders.value.toInvoice.slice(0, 8) };
    out.unpaidInvoices = {
      count: orders.value.unpaid.length,
      overdue: orders.value.unpaid.filter((o) => o.overdue).length,
      items: orders.value.unpaid.slice(0, 8),
    };
  } else errors.push("wholesale orders");
  if (rets.status === "fulfilled") out.returns = { count: rets.value.length };
  else errors.push("returns");
  out.total =
    (out.applications?.count ?? 0) + (out.toInvoice?.count ?? 0) + (out.unpaidInvoices?.count ?? 0) + (out.returns?.count ?? 0);
  return out;
}
