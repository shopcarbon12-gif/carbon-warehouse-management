/**
 * Visitors (Shopify → Visitors, owner 2026-10-21) — recording what real
 * visitors do on shopcarbon.com, kept after they leave.
 *
 * Written from:
 *  - every Carbon Shield page-view check the verdict calls a real person
 *    (lib/server/shield/check.ts) — bots and crawlers never reach here;
 *  - /api/shield/event: cart adds, checkout starts, "still here" pings;
 *  - the email popup / footer signup (lib/server/welcome) — gives the email;
 *  - the orders/paid webhook — the order, via the cart attribute _cs_vid the
 *    theme sets on the first cart add (or the visitor's known email).
 * A logged-in shopper is named only when Shopify's Liquid signed their
 * customer id (the wishlist's CARBON_WISHLIST_SECRET), so nobody can claim to
 * be someone else. No screen recording, nothing typed into forms.
 * Kept 90 days (pruneVisitors, run by the worker).
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import { decodeEntities, describeDevice, shortName, visitorLabel } from "./rules";
import { notifyVisitor } from "./alerts";

const clip = (s: unknown, n: number) => (typeof s === "string" ? s.trim().slice(0, n) : "");
export const VISIT_GAP_MINUTES = 30;
export const KEEP_DAYS = 90;

export type SignedCustomer = { id?: unknown; ts?: unknown; sig?: unknown; f?: unknown; l?: unknown; e?: unknown };

function secret(): string {
  return (process.env.CARBON_WISHLIST_SECRET || "").trim().replace(/^["']|["']$/g, "");
}

/** The logged-in customer, when Liquid's signature over `${id}.${ts}` checks out (7 days max). */
export function verifiedCustomer(c: SignedCustomer | undefined | null): { id: string; name: string | null; email: string | null } | null {
  if (!c || typeof c !== "object") return null;
  const id = String(c.id ?? "").trim();
  const ts = String(c.ts ?? "").trim();
  const sig = String(c.sig ?? "").trim();
  const key = secret();
  if (!key || !/^\d{1,20}$/.test(id) || !/^\d{1,20}$/.test(ts) || !/^[a-f0-9]{64}$/.test(sig)) return null;
  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (age > 7 * 86_400 || age < -300) return null;
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}`).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  const email = clip(c.e, 254).toLowerCase() || null;
  return { id, name: shortName(clip(c.f, 60), clip(c.l, 60)), email };
}

export type PageView = {
  visitorId: string;
  ip: string | null;
  ua: string;
  country: string | null;
  asn: number | null;
  network: string | null;
  source: string;
  ad: string | null;
  path: string | null;
  title: string | null;
  product: string | null;
  customer: SignedCustomer | null | undefined;
};

/** One real page view. Never throws. */
export async function recordPageView(pool: Pool, v: PageView): Promise<void> {
  try {
    const dev = describeDevice(v.ua);
    v = { ...v, title: v.title ? decodeEntities(v.title) : null };
    const who = verifiedCustomer(v.customer);
    // Before the write: is this someone new, or the start of a new visit? (for the alerts)
    const prev = (
      await pool.query<{ fresh_visit: boolean; nickname: string | null; customer_name: string | null; email: string | null }>(
        `SELECT last_seen < now() - make_interval(mins => ${VISIT_GAP_MINUTES}) AS fresh_visit, nickname, customer_name, email
           FROM visitors WHERE visitor_id = $1`,
        [v.visitorId],
      )
    ).rows[0];
    const r = await pool.query<{ visits: number }>(
      `INSERT INTO visitors
         (visitor_id, ip, country, asn, network, device, os, browser, first_source, first_ad, landing_path,
          last_source, last_path, last_title, page_views, customer_id, customer_name, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $9, $11, $12, 1, $13, $14, $15)
       ON CONFLICT (visitor_id) DO UPDATE SET
         visits = visitors.visits + CASE WHEN visitors.last_seen < now() - make_interval(mins => ${VISIT_GAP_MINUTES}) THEN 1 ELSE 0 END,
         page_views = visitors.page_views + 1,
         last_seen = now(),
         ip = EXCLUDED.ip, country = EXCLUDED.country, asn = EXCLUDED.asn, network = EXCLUDED.network,
         device = EXCLUDED.device, os = EXCLUDED.os, browser = EXCLUDED.browser,
         last_source = CASE WHEN EXCLUDED.last_source = 'internal' THEN visitors.last_source ELSE EXCLUDED.last_source END,
         last_path = EXCLUDED.last_path, last_title = EXCLUDED.last_title,
         customer_id = COALESCE(EXCLUDED.customer_id, visitors.customer_id),
         customer_name = COALESCE(EXCLUDED.customer_name, visitors.customer_name),
         email = COALESCE(EXCLUDED.email, visitors.email)
       RETURNING visits`,
      [
        v.visitorId,
        v.ip,
        v.country,
        v.asn,
        v.network,
        dev.device,
        dev.os,
        dev.browser,
        v.source,
        v.ad,
        v.path,
        v.title,
        who?.id ?? null,
        who?.name ?? null,
        who?.email ?? null,
      ],
    );
    await pool.query(
      `INSERT INTO visitor_events (visitor_id, visit, kind, path, title, source, detail)
       VALUES ($1, $2, 'view', $3, $4, $5, $6)`,
      [v.visitorId, r.rows[0]?.visits ?? 1, v.path, v.title, v.source, v.product ? { product: v.product } : null],
    );
    if (!prev || prev.fresh_visit) {
      const label = prev
        ? visitorLabel({ visitor_id: v.visitorId, nickname: prev.nickname, customer_name: who?.name ?? prev.customer_name, email: who?.email ?? prev.email })
        : who?.name ?? null;
      void notifyVisitor(pool, {
        kind: prev ? "visitor_back" : "visitor_new",
        visitorId: v.visitorId,
        visit: r.rows[0]?.visits ?? 1,
        label: label && !label.startsWith("Visitor ") ? label : null,
        country: v.country,
        source: v.source,
        device: dev.device,
        pageTitle: v.title,
        path: v.path,
      });
    }
  } catch (e) {
    console.warn("[visitors] page view not recorded:", e instanceof Error ? e.message : e);
  }
}

export type VisitorEvent = {
  visitorId: string;
  kind: "cart_add" | "checkout" | "ping";
  path: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * Cart add / checkout start / ping from the theme. Only for a visitor a real
 * page view already created (bots that skip the page check get nothing).
 */
export async function recordVisitorEvent(pool: Pool, ev: VisitorEvent): Promise<boolean> {
  const counter = ev.kind === "cart_add" ? ", cart_adds = cart_adds + 1" : ev.kind === "checkout" ? ", checkouts = checkouts + 1" : "";
  const r = await pool.query<{
    visits: number;
    nickname: string | null;
    customer_name: string | null;
    email: string | null;
    country: string | null;
    last_source: string | null;
    device: string | null;
    last_title: string | null;
    last_path: string | null;
  }>(
    `UPDATE visitors SET last_seen = now()${counter}
      WHERE visitor_id = $1 AND last_seen > now() - interval '6 hours'
      RETURNING visits, nickname, customer_name, email, country, last_source, device, last_title, last_path`,
    [ev.visitorId],
  );
  if (!r.rowCount) return false;
  if (ev.kind !== "ping") {
    await pool.query(
      `INSERT INTO visitor_events (visitor_id, visit, kind, path, title, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
      [ev.visitorId, r.rows[0].visits, ev.kind, ev.path, clip(ev.detail?.title, 200) || null, ev.detail ?? null],
    );
    const row = r.rows[0];
    const label = visitorLabel({ visitor_id: ev.visitorId, ...row });
    const base = {
      visitorId: ev.visitorId,
      visit: row.visits,
      label: label.startsWith("Visitor ") ? null : label,
      country: row.country,
      source: row.last_source,
      device: row.device,
      pageTitle: row.last_title,
      path: row.last_path,
    };
    if (ev.kind === "cart_add") {
      const d = ev.detail ?? {};
      void notifyVisitor(pool, {
        ...base,
        kind: "visitor_cart",
        product: typeof d.title === "string" ? d.title : null,
        variant: typeof d.variant === "string" ? d.variant : null,
        price: typeof d.price === "number" ? d.price : null,
      });
    } else {
      const items = await pool.query<{ title: string | null }>(
        `SELECT detail->>'title' AS title FROM visitor_events WHERE visitor_id = $1 AND visit = $2 AND kind = 'cart_add' ORDER BY at`,
        [ev.visitorId, row.visits],
      );
      void notifyVisitor(pool, { ...base, kind: "visitor_checkout", cartItems: items.rows.map((i) => i.title || "a product") });
    }
  }
  return true;
}

/** Email popup / footer signup: the visitor now has an email. Never throws. */
export async function linkVisitorSignup(pool: Pool, visitorId: string, email: string, form: string): Promise<void> {
  try {
    const r = await pool.query<{ visits: number; last_path: string | null }>(
      `UPDATE visitors SET email = COALESCE(email, $2) WHERE visitor_id = $1 RETURNING visits, last_path`,
      [visitorId, email],
    );
    if (!r.rowCount) return;
    await pool.query(
      `INSERT INTO visitor_events (visitor_id, visit, kind, path, detail) VALUES ($1, $2, 'signup', $3, $4)`,
      [visitorId, r.rows[0].visits, r.rows[0].last_path, { form, email }],
    );
  } catch (e) {
    console.warn("[visitors] signup not linked:", e instanceof Error ? e.message : e);
  }
}

export type PaidOrder = {
  name?: string | null;
  total_price?: string | number | null;
  email?: string | null;
  customer?: { id?: number | string | null; first_name?: string | null; last_name?: string | null; email?: string | null } | null;
  note_attributes?: { name?: string | null; value?: string | null }[] | null;
  line_items?: { title?: string | null; variant_title?: string | null; quantity?: number | null }[] | null;
};

/** orders/paid: credit the order to the visitor who placed it. Never throws. */
export async function linkVisitorOrder(pool: Pool, order: PaidOrder): Promise<void> {
  try {
    const vid = (order.note_attributes ?? []).find((a) => a?.name === "_cs_vid")?.value?.trim().slice(0, 64) || null;
    const email = (order.email || order.customer?.email || "").trim().toLowerCase() || null;
    let visitorId = vid;
    if (!visitorId && email) {
      const m = await pool.query<{ visitor_id: string }>(
        `SELECT visitor_id FROM visitors WHERE lower(email) = $1 ORDER BY last_seen DESC LIMIT 1`,
        [email],
      );
      visitorId = m.rows[0]?.visitor_id ?? null;
    }
    if (!visitorId) return;
    // Idempotent per order: a re-delivered webhook adds nothing.
    const dup = await pool.query(
      `SELECT 1 FROM visitor_events WHERE visitor_id = $1 AND kind = 'order' AND detail->>'order' = $2`,
      [visitorId, order.name ?? ""],
    );
    if (dup.rowCount) return;
    const total = Number(order.total_price);
    const name = shortName(order.customer?.first_name ?? "", order.customer?.last_name ?? "");
    const r = await pool.query<{ visits: number }>(
      `UPDATE visitors
          SET orders = orders + 1, revenue = revenue + $2,
              customer_id = COALESCE(customer_id, $3), customer_name = COALESCE(customer_name, $4), email = COALESCE(email, $5)
        WHERE visitor_id = $1 RETURNING visits`,
      [visitorId, Number.isFinite(total) ? total : 0, order.customer?.id ? String(order.customer.id) : null, name, email],
    );
    if (!r.rowCount) return;
    await pool.query(
      `INSERT INTO visitor_events (visitor_id, visit, kind, detail) VALUES ($1, $2, 'order', $3)`,
      [
        visitorId,
        r.rows[0].visits,
        {
          order: order.name ?? "",
          total: Number.isFinite(total) ? total : null,
          items: (order.line_items ?? []).slice(0, 20).map((li) => ({ title: li.title, variant: li.variant_title, qty: li.quantity })),
        },
      ],
    );
  } catch (e) {
    console.warn("[visitors] order not linked:", e instanceof Error ? e.message : e);
  }
}

/** Worker: events older than 90 days go; so do unnamed visitors not seen for 90 days. */
export async function pruneVisitors(pool: Pool): Promise<{ events: number; visitors: number }> {
  const ev = await pool.query(`DELETE FROM visitor_events WHERE at < now() - make_interval(days => ${KEEP_DAYS})`);
  const vi = await pool.query(
    `DELETE FROM visitors
      WHERE last_seen < now() - make_interval(days => ${KEEP_DAYS})
        AND nickname IS NULL AND note IS NULL AND customer_id IS NULL AND email IS NULL AND orders = 0`,
  );
  await pool.query(`DELETE FROM visitor_alerts WHERE at < now() - make_interval(days => ${KEEP_DAYS})`);
  return { events: ev.rowCount ?? 0, visitors: vi.rowCount ?? 0 };
}
