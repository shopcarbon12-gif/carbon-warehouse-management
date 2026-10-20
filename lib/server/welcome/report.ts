/**
 * Email Popup — what the WMS page (Shopify → Email Popup) shows: settings,
 * signups and codes used, and the store's always-on automatic discounts.
 *
 * Why the automatic discounts: a welcome code never combines with them, and
 * Shopify gives the shopper whichever discount saves more. So a code that is
 * not BIGGER than what a one-item order already gets automatically is never
 * used (tested on live carts 2026-10-20: a 10% code lost to "BUY 1 GET 10%
 * OFF" every time; 15% won on one item, lost to the 20% on two).
 */
import type { Pool } from "pg";
import { getWelcomeSettings, welcomeGql, welcomeShopCtx, type WelcomeSettings } from "./config";

export type SaleDiscount = { title: string; percent: number; minQuantity: number | null };

export type WelcomeSignupRow = {
  createdAt: string;
  email: string;
  code: string;
  percent: number;
  endsAt: string;
  status: "used" | "expired" | "open";
  existingCustomer: boolean;
  emailedAt: string | null;
  emailError: string | null;
  unsubscribed: boolean;
  path: string | null;
  country: string | null;
  orderName: string | null;
  orderTotal: number | null;
};

export type WelcomeReport = {
  settings: WelcomeSettings;
  sale: SaleDiscount[];
  /** Biggest % a one-item order already gets automatically (0 = none). */
  floorPercent: number;
  totals: {
    today: number;
    week: number;
    month: number;
    all: number;
    newCustomers: number;
    used: number;
    revenue: number;
    unsubscribed: number;
    emailErrors: number;
  };
  daily: { day: string; signups: number; used: number }[];
  recent: WelcomeSignupRow[];
  emailReady: boolean;
};

let saleCache: { at: number; sale: SaleDiscount[] } | null = null;

async function activeSaleDiscounts(): Promise<SaleDiscount[]> {
  if (saleCache && Date.now() - saleCache.at < 5 * 60_000) return saleCache.sale;
  const ctx = await welcomeShopCtx();
  if (!ctx) return [];
  type Node = {
    automaticDiscount: {
      title?: string;
      minimumRequirement?: { greaterThanOrEqualToQuantity?: string; greaterThanOrEqualToSubtotal?: unknown } | null;
      customerGets?: { value?: { percentage?: number } };
    };
  };
  const d = await welcomeGql<{ automaticDiscountNodes: { nodes: Node[] } }>(
    ctx,
    `{ automaticDiscountNodes(first: 50, query: "status:active") { nodes { automaticDiscount {
        ... on DiscountAutomaticBasic {
          title
          minimumRequirement {
            ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
            ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
          }
          customerGets { value { ... on DiscountPercentage { percentage } } }
        } } } } }`,
  );
  const sale = d.automaticDiscountNodes.nodes
    .map((n) => n.automaticDiscount)
    .filter((a) => typeof a.customerGets?.value?.percentage === "number" && !a.minimumRequirement?.greaterThanOrEqualToSubtotal)
    .map((a) => ({
      title: a.title ?? "Automatic discount",
      percent: Math.round((a.customerGets!.value!.percentage as number) * 100),
      minQuantity: a.minimumRequirement?.greaterThanOrEqualToQuantity ? Number(a.minimumRequirement.greaterThanOrEqualToQuantity) : null,
    }))
    .sort((a, b) => (a.minQuantity ?? 0) - (b.minQuantity ?? 0) || a.percent - b.percent);
  saleCache = { at: Date.now(), sale };
  return sale;
}

export async function getWelcomeReport(pool: Pool): Promise<WelcomeReport> {
  const [settings, sale, totals, daily, recent] = await Promise.all([
    getWelcomeSettings(pool),
    activeSaleDiscounts().catch((e) => {
      console.warn("[welcome] sale discounts", e instanceof Error ? e.message : e);
      return [] as SaleDiscount[];
    }),
    pool.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')) AS today,
         count(*) FILTER (WHERE created_at > now() - interval '7 days') AS week,
         count(*) FILTER (WHERE created_at > now() - interval '30 days') AS month,
         count(*) AS all,
         count(*) FILTER (WHERE NOT existing_customer) AS new_customers,
         count(*) FILTER (WHERE used_at IS NOT NULL) AS used,
         COALESCE(sum(used_order_total) FILTER (WHERE used_at IS NOT NULL), 0) AS revenue,
         count(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS unsubscribed,
         count(*) FILTER (WHERE email_error IS NOT NULL) AS email_errors
       FROM welcome_signups`,
    ),
    pool.query<{ day: string; signups: string; used: string }>(
      `WITH days AS (
         SELECT generate_series((now() AT TIME ZONE 'America/New_York')::date - 29, (now() AT TIME ZONE 'America/New_York')::date, '1 day')::date AS day
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
              (SELECT count(*) FROM welcome_signups s WHERE (s.created_at AT TIME ZONE 'America/New_York')::date = d.day) AS signups,
              (SELECT count(*) FROM welcome_signups s WHERE (s.used_at AT TIME ZONE 'America/New_York')::date = d.day) AS used
         FROM days d ORDER BY d.day`,
    ),
    pool.query<{
      created_at: Date;
      email: string;
      code: string;
      percent_off: number;
      ends_at: Date;
      used_at: Date | null;
      existing_customer: boolean;
      emailed_at: Date | null;
      email_error: string | null;
      unsubscribed_at: Date | null;
      source_path: string | null;
      country: string | null;
      used_order_name: string | null;
      used_order_total: string | null;
    }>(
      `SELECT created_at, email, code, percent_off, ends_at, used_at, existing_customer, emailed_at, email_error,
              unsubscribed_at, source_path, country, used_order_name, used_order_total
         FROM welcome_signups ORDER BY created_at DESC LIMIT 100`,
    ),
  ]);

  const t = totals.rows[0] ?? {};
  const n = (k: string) => Number(t[k] ?? 0);
  const floorPercent = sale.filter((s) => (s.minQuantity ?? 0) <= 1).reduce((m, s) => Math.max(m, s.percent), 0);
  return {
    settings,
    sale,
    floorPercent,
    totals: {
      today: n("today"),
      week: n("week"),
      month: n("month"),
      all: n("all"),
      newCustomers: n("new_customers"),
      used: n("used"),
      revenue: Math.round(n("revenue") * 100) / 100,
      unsubscribed: n("unsubscribed"),
      emailErrors: n("email_errors"),
    },
    daily: daily.rows.map((r) => ({ day: r.day, signups: Number(r.signups), used: Number(r.used) })),
    recent: recent.rows.map((r) => ({
      createdAt: r.created_at.toISOString(),
      email: r.email,
      code: r.code,
      percent: r.percent_off,
      endsAt: r.ends_at.toISOString(),
      status: r.used_at ? "used" : r.ends_at.getTime() <= Date.now() ? "expired" : "open",
      existingCustomer: r.existing_customer,
      emailedAt: r.emailed_at ? r.emailed_at.toISOString() : null,
      emailError: r.email_error,
      unsubscribed: !!r.unsubscribed_at,
      path: r.source_path,
      country: r.country,
      orderName: r.used_order_name,
      orderTotal: r.used_order_total === null ? null : Number(r.used_order_total),
    })),
    emailReady: !!(process.env.RESEND_API_KEY || "").trim(),
  };
}
