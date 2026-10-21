/**
 * Visitors — what Shopify → Visitors shows: who is on the store now, every
 * recorded visitor with filters, and one visitor's whole journey.
 */
import type { Pool } from "pg";
import { visitorLabel } from "./rules";

/** "On the site now" = a page view or a still-here ping in the last 3 minutes. */
export const LIVE_MINUTES = 3;

export type VisitorRow = {
  visitorId: string;
  label: string;
  nickname: string | null;
  note: string | null;
  customerName: string | null;
  email: string | null;
  firstSeen: string;
  lastSeen: string;
  live: boolean;
  visits: number;
  pageViews: number;
  country: string | null;
  network: string | null;
  device: string | null;
  os: string | null;
  browser: string | null;
  firstSource: string | null;
  firstAd: string | null;
  landingPath: string | null;
  lastSource: string | null;
  lastPath: string | null;
  lastTitle: string | null;
  cartAdds: number;
  checkouts: number;
  orders: number;
  revenue: number;
};

type DbRow = {
  visitor_id: string;
  nickname: string | null;
  note: string | null;
  customer_name: string | null;
  email: string | null;
  first_seen: Date;
  last_seen: Date;
  visits: number;
  page_views: number;
  country: string | null;
  network: string | null;
  device: string | null;
  os: string | null;
  browser: string | null;
  first_source: string | null;
  first_ad: string | null;
  landing_path: string | null;
  last_source: string | null;
  last_path: string | null;
  last_title: string | null;
  cart_adds: number;
  checkouts: number;
  orders: number;
  revenue: string;
};

function toRow(r: DbRow): VisitorRow {
  return {
    visitorId: r.visitor_id,
    label: visitorLabel(r),
    nickname: r.nickname,
    note: r.note,
    customerName: r.customer_name,
    email: r.email,
    firstSeen: r.first_seen.toISOString(),
    lastSeen: r.last_seen.toISOString(),
    live: Date.now() - r.last_seen.getTime() < LIVE_MINUTES * 60_000,
    visits: r.visits,
    pageViews: r.page_views,
    country: r.country,
    network: r.network,
    device: r.device,
    os: r.os,
    browser: r.browser,
    firstSource: r.first_source,
    firstAd: r.first_ad,
    landingPath: r.landing_path,
    lastSource: r.last_source,
    lastPath: r.last_path,
    lastTitle: r.last_title,
    cartAdds: r.cart_adds,
    checkouts: r.checkouts,
    orders: r.orders,
    revenue: Number(r.revenue),
  };
}

export const FILTERS = ["all", "named", "returning", "ads", "cart", "ordered"] as const;
export type VisitorFilter = (typeof FILTERS)[number];

const FILTER_SQL: Record<VisitorFilter, string> = {
  all: "TRUE",
  named: "(v.nickname IS NOT NULL OR v.customer_name IS NOT NULL OR v.email IS NOT NULL)",
  returning: "v.visits > 1",
  ads: "(v.first_ad IS NOT NULL OR v.first_source LIKE 'ad:%' OR v.last_source LIKE 'ad:%')",
  cart: "(v.cart_adds > 0 AND v.orders = 0)",
  ordered: "v.orders > 0",
};

export type VisitorList = {
  rows: VisitorRow[];
  total: number;
  liveNow: number;
  today: { visitors: number; pageViews: number; cartAdds: number; checkouts: number; orders: number };
};

export async function listVisitors(
  pool: Pool,
  opts: { live: boolean; filter: VisitorFilter; q: string; offset: number; limit: number },
): Promise<VisitorList> {
  const where: string[] = [FILTER_SQL[opts.filter]];
  const vals: unknown[] = [];
  if (opts.live) where.push(`v.last_seen > now() - make_interval(mins => ${LIVE_MINUTES})`);
  const q = opts.q.trim();
  if (q) {
    vals.push(`%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%`);
    const p = `$${vals.length}`;
    where.push(
      `(v.nickname ILIKE ${p} OR v.note ILIKE ${p} OR v.customer_name ILIKE ${p} OR v.email ILIKE ${p} OR v.country ILIKE ${p}
        OR v.network ILIKE ${p} OR v.visitor_id ILIKE ${p}
        OR EXISTS (SELECT 1 FROM visitor_events e WHERE e.visitor_id = v.visitor_id AND (e.title ILIKE ${p} OR e.path ILIKE ${p})))`,
    );
  }
  const cond = where.join(" AND ");
  const [rows, total, live, today] = await Promise.all([
    pool.query<DbRow>(
      `SELECT v.* FROM visitors v WHERE ${cond} ORDER BY v.last_seen DESC LIMIT ${opts.limit} OFFSET ${opts.offset}`,
      vals,
    ),
    pool.query<{ n: string }>(`SELECT count(*) AS n FROM visitors v WHERE ${cond}`, vals),
    pool.query<{ n: string }>(`SELECT count(*) AS n FROM visitors WHERE last_seen > now() - make_interval(mins => ${LIVE_MINUTES})`),
    pool.query<Record<string, string>>(
      `SELECT count(DISTINCT visitor_id) AS visitors,
              count(*) FILTER (WHERE kind = 'view') AS views,
              count(*) FILTER (WHERE kind = 'cart_add') AS cart,
              count(*) FILTER (WHERE kind = 'checkout') AS checkouts,
              count(*) FILTER (WHERE kind = 'order') AS orders
         FROM visitor_events
        WHERE at >= (date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York')`,
    ),
  ]);
  const t = today.rows[0] ?? {};
  return {
    rows: rows.rows.map(toRow),
    total: Number(total.rows[0]?.n ?? 0),
    liveNow: Number(live.rows[0]?.n ?? 0),
    today: {
      visitors: Number(t.visitors ?? 0),
      pageViews: Number(t.views ?? 0),
      cartAdds: Number(t.cart ?? 0),
      checkouts: Number(t.checkouts ?? 0),
      orders: Number(t.orders ?? 0),
    },
  };
}

export type VisitorEventRow = {
  at: string;
  visit: number;
  kind: "view" | "cart_add" | "checkout" | "signup" | "order";
  path: string | null;
  title: string | null;
  source: string | null;
  detail: Record<string, unknown> | null;
};

export type VisitorDetail = {
  visitor: VisitorRow & { ip: string | null; labelledAt: string | null; labelledByEmail: string | null };
  events: VisitorEventRow[];
  /** The same person on other devices (same email or customer account). */
  otherDevices: { visitorId: string; label: string; device: string | null; lastSeen: string }[];
};

export async function getVisitor(pool: Pool, visitorId: string): Promise<VisitorDetail | null> {
  const v = await pool.query<DbRow & { ip: string | null; labelled_at: Date | null; labelled_by_email: string | null; customer_id: string | null }>(
    `SELECT * FROM visitors WHERE visitor_id = $1`,
    [visitorId],
  );
  const row = v.rows[0];
  if (!row) return null;
  const [events, others] = await Promise.all([
    pool.query<{ at: Date; visit: number; kind: VisitorEventRow["kind"]; path: string | null; title: string | null; source: string | null; detail: Record<string, unknown> | null }>(
      `SELECT at, visit, kind, path, title, source, detail FROM visitor_events WHERE visitor_id = $1 ORDER BY at DESC LIMIT 1000`,
      [visitorId],
    ),
    row.email || row.customer_id
      ? pool.query<DbRow>(
          `SELECT * FROM visitors
            WHERE visitor_id <> $1 AND ((lower(email) = lower($2) AND $2 <> '') OR (customer_id = $3 AND $3 <> ''))
            ORDER BY last_seen DESC LIMIT 10`,
          [visitorId, row.email ?? "", row.customer_id ?? ""],
        )
      : Promise.resolve({ rows: [] as DbRow[] }),
  ]);
  return {
    visitor: {
      ...toRow(row),
      ip: row.ip,
      labelledAt: row.labelled_at ? row.labelled_at.toISOString() : null,
      labelledByEmail: row.labelled_by_email,
    },
    events: events.rows.map((e) => ({ ...e, at: e.at.toISOString() })),
    otherDevices: others.rows.map((o) => ({ visitorId: o.visitor_id, label: visitorLabel(o), device: o.device, lastSeen: o.last_seen.toISOString() })),
  };
}
