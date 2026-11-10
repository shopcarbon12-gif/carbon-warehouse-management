/**
 * CarbonWMS Email — Flows engine (phase 4): automatic emails.
 *
 * Every minute while a flow is live (the worker's /api/email/tick):
 *   1. pollTriggers (at most every 5 minutes per store) reads what happened since last time —
 *      Shopify orders and abandoned checkouts, Carbon POS sales, website sign-ups — keeps every
 *      paid order in email_orders_seen, and puts people into the live flows that match
 *      (email_flow_runs; one run per order / checkout / sign-up / lapse, never twice).
 *      Only things that happened after the flow was turned on count.
 *   2. runFlowSteps walks each person's next steps: waits, "stop if they ordered", and emails
 *      (sent in the store's send window, never to unsubscribed / bounced people, skipped when
 *      they got an email in the last N hours, a personal Shopify code when the step has an offer).
 *
 * A paused flow keeps its people where they are; a draft flow does nothing.
 */
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { normalizeEmail } from "@/lib/server/welcome/rules";
import { SesSendError, getEmailSettings, sesPacing, sesSend } from "./config";
import { createPersonalCode, mergeValuesFor, unsubscribeUrl, type Offer } from "./campaigns";
import { createEditorEmail, editorHtml, readyEditorPics } from "./editor";
import { loadPics } from "./text-pics";
import { fillMergeTags, htmlToText, wrapEmail } from "./rules";
import { picSources } from "@/lib/email-editor/render";
import { isDoc, type EmailDoc, type ProductItem } from "@/lib/email-editor/types";
import {
  FLOW_IDEAS,
  blankFlow,
  flowProblems,
  inWindow,
  isSettings,
  isStep,
  isTrigger,
  waitMs,
  type EmailStep,
  type FlowDraft,
  type FlowKind,
  type FlowSettings,
  type FlowStep,
  type Trigger,
} from "@/lib/email-editor/flows";

/** Amazon SES and Shopify codes; the tests swap in fakes so nothing real is sent or made. */
let deps = { send: sesSend, code: createPersonalCode, pacing: sesPacing };
export function setFlowDepsForTests(d: Partial<typeof deps>): void {
  deps = { ...deps, ...d };
}

const POLL_EVERY_MS = 5 * 60_000;
const BACKFILL_DAYS = 400;
const TICK_BUDGET_MS = 50_000;

export type FlowRow = {
  id: string;
  tenant_id: string;
  name: string;
  kind: FlowKind;
  trigger: Trigger;
  steps: FlowStep[];
  settings: FlowSettings;
  status: "draft" | "live" | "paused";
  live_since: string | null;
  created_at: string;
  updated_at: string;
};

/* ------------------------------------------------------------------ CRUD */

export async function listFlows(pool: Pool, tenantId: string): Promise<(FlowRow & { stats: FlowStats })[]> {
  const r = await pool.query<FlowRow>(
    `SELECT id::text, tenant_id::text, name, kind, trigger, steps, settings, status, live_since, created_at, updated_at
       FROM email_flows WHERE tenant_id = $1::uuid AND archived_at IS NULL ORDER BY created_at`,
    [tenantId],
  );
  const stats = await flowStats(
    pool,
    r.rows.map((x) => x.id),
  );
  return r.rows.map((f) => ({ ...f, stats: stats.get(f.id) ?? emptyStats() }));
}

export async function getFlow(pool: Pool, tenantId: string, id: string): Promise<FlowRow | null> {
  const r = await pool.query<FlowRow>(
    `SELECT id::text, tenant_id::text, name, kind, trigger, steps, settings, status, live_since, created_at, updated_at
       FROM email_flows WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL`,
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

/** A new flow from a ready-made idea (its emails are made from the matching starters) or blank. */
export async function createFlow(pool: Pool, tenantId: string, by: string | null, kind: FlowKind): Promise<string> {
  const idea = FLOW_IDEAS.find((x) => x.kind === kind);
  const draft: FlowDraft = idea ? idea.make() : blankFlow();
  if (idea) {
    const emails = draft.steps.filter((s): s is EmailStep => s.type === "email");
    for (let i = 0; i < emails.length; i++) {
      const starter = idea.starters[Math.min(i, idea.starters.length - 1)];
      emails[i].designId = await createEditorEmail(pool, tenantId, by, {
        starter,
        title: `Flow · ${emails[i].name}`,
      });
      await pool.query(`UPDATE email_designs SET subject_hint = $2, preheader_hint = $3 WHERE id = $1::uuid`, [emails[i].designId, emails[i].subject, emails[i].preheader]);
    }
  }
  const r = await pool.query<{ id: string }>(`INSERT INTO email_flows (tenant_id, name, kind, trigger, steps, settings, created_by) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) RETURNING id::text`, [
    tenantId,
    draft.name,
    draft.kind,
    JSON.stringify(draft.trigger),
    JSON.stringify(draft.steps),
    JSON.stringify(draft.settings),
    by,
  ]);
  return r.rows[0].id;
}

export async function saveFlow(
  pool: Pool,
  tenantId: string,
  id: string,
  input: {
    name?: unknown;
    trigger?: unknown;
    steps?: unknown;
    settings?: unknown;
  },
): Promise<FlowRow> {
  const f = await getFlow(pool, tenantId, id);
  if (!f) throw new Error("Flow not found");
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 80) || f.name : f.name;
  const trigger = input.trigger === undefined ? f.trigger : input.trigger;
  const steps = input.steps === undefined ? f.steps : input.steps;
  const settings = input.settings === undefined ? f.settings : input.settings;
  if (!isTrigger(trigger)) throw new Error("Invalid trigger");
  if (!Array.isArray(steps) || steps.length > 40 || !steps.every(isStep)) throw new Error("Invalid steps");
  if (new Set(steps.map((s) => s.id)).size !== steps.length) throw new Error("Invalid steps");
  if (!isSettings(settings)) throw new Error("Invalid settings");
  // A live flow's trigger is fixed: people already inside came in through it.
  if (f.status !== "draft" && JSON.stringify(trigger) !== JSON.stringify(f.trigger)) throw new Error("Pause the flow and set it back to draft to change what starts it");
  const ids = steps.filter((s): s is EmailStep => s.type === "email" && !!s.designId).map((s) => s.designId as string);
  if (ids.length) {
    const ok = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM email_designs WHERE tenant_id = $1::uuid AND id = ANY($2::uuid[]) AND archived_at IS NULL`, [tenantId, [...new Set(ids)]]);
    if (ok.rows[0].n !== new Set(ids).size) throw new Error("One of the picked emails no longer exists");
  }
  await pool.query(`UPDATE email_flows SET name = $2, trigger = $3, steps = $4, settings = $5, updated_at = now() WHERE id = $1::uuid`, [
    id,
    name,
    JSON.stringify(trigger),
    JSON.stringify(steps),
    JSON.stringify(settings),
  ]);
  return (await getFlow(pool, tenantId, id))!;
}

export async function setFlowStatus(pool: Pool, tenantId: string, id: string, status: "draft" | "live" | "paused"): Promise<FlowRow> {
  const f = await getFlow(pool, tenantId, id);
  if (!f) throw new Error("Flow not found");
  if (status === "live") {
    const problems = flowProblems(f);
    if (problems.length) throw new Error(problems.join(" "));
  }
  if (status === "draft" && f.status !== "draft") {
    // Back to draft: the people inside leave (so the trigger can change safely).
    await pool.query(`UPDATE email_flow_runs SET status = 'exited', exit_reason = 'Flow set back to draft', updated_at = now() WHERE flow_id = $1::uuid AND status = 'active'`, [id]);
  }
  // Only what happens from now on starts the flow (no flood of old orders or sign-ups).
  await pool.query(`UPDATE email_flows SET status = $2, live_since = CASE WHEN $2 = 'live' THEN now() ELSE live_since END, updated_at = now() WHERE id = $1::uuid`, [id, status]);
  return (await getFlow(pool, tenantId, id))!;
}

export async function archiveFlow(pool: Pool, tenantId: string, id: string): Promise<void> {
  await pool.query(`UPDATE email_flows SET archived_at = now(), status = 'draft', updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tenantId]);
  await pool.query(`UPDATE email_flow_runs SET status = 'exited', exit_reason = 'Flow deleted', updated_at = now() WHERE flow_id = $1::uuid AND status = 'active'`, [id]);
}

/* ----------------------------------------------------------------- stats */

export type StepStats = {
  sent: number;
  skipped: number;
  delivered: number;
  opened: number;
  clicked: number;
  orders: number;
  revenue: number;
};
export type FlowStats = {
  inside: number;
  entered: number;
  sent: number;
  opened: number;
  clicked: number;
  orders: number;
  revenue: number;
  steps: Record<string, StepStats>;
};
const emptyStats = (): FlowStats => ({
  inside: 0,
  entered: 0,
  sent: 0,
  opened: 0,
  clicked: 0,
  orders: 0,
  revenue: 0,
  steps: {},
});

/** Orders "from" a flow email: the person ordered within 5 days after it (Klaviyo's default window). */
export async function flowStats(pool: Pool, flowIds: string[]): Promise<Map<string, FlowStats>> {
  const out = new Map<string, FlowStats>();
  if (!flowIds.length) return out;
  for (const id of flowIds) out.set(id, emptyStats());
  const runs = await pool.query<{
    flow_id: string;
    inside: number;
    entered: number;
  }>(`SELECT flow_id::text, count(*) FILTER (WHERE status = 'active')::int AS inside, count(*)::int AS entered FROM email_flow_runs WHERE flow_id = ANY($1::uuid[]) GROUP BY flow_id`, [flowIds]);
  for (const r of runs.rows)
    Object.assign(out.get(r.flow_id)!, {
      inside: r.inside,
      entered: r.entered,
    });
  const sends = await pool.query<{
    flow_id: string;
    step_id: string;
    sent: number;
    skipped: number;
    delivered: number;
    opened: number;
    clicked: number;
    orders: number;
    revenue: string;
  }>(
    `SELECT s.flow_id::text, s.step_id,
            count(*) FILTER (WHERE s.status = 'sent')::int AS sent,
            count(*) FILTER (WHERE s.status = 'skipped')::int AS skipped,
            count(s.delivered_at)::int AS delivered, count(s.opened_at)::int AS opened, count(s.clicked_at)::int AS clicked,
            count(o.order_id)::int AS orders, COALESCE(sum(o.total), 0)::text AS revenue
       FROM email_flow_sends s
       LEFT JOIN LATERAL (
         SELECT x.order_id, x.total FROM email_orders_seen x
          WHERE x.email = s.email AND x.processed_at > s.sent_at AND x.processed_at < s.sent_at + interval '5 days'
          ORDER BY x.processed_at LIMIT 1
       ) o ON s.status = 'sent'
      WHERE s.flow_id = ANY($1::uuid[])
      GROUP BY s.flow_id, s.step_id`,
    [flowIds],
  );
  for (const r of sends.rows) {
    const f = out.get(r.flow_id)!;
    const st: StepStats = {
      sent: r.sent,
      skipped: r.skipped,
      delivered: r.delivered,
      opened: r.opened,
      clicked: r.clicked,
      orders: r.orders,
      revenue: Number(r.revenue),
    };
    f.steps[r.step_id] = st;
    f.sent += st.sent;
    f.opened += st.opened;
    f.clicked += st.clicked;
    f.orders += st.orders;
    f.revenue += st.revenue;
  }
  return out;
}

/** The latest people in a flow (the flow page's "Who is in it"). */
export async function flowPeople(pool: Pool, flowId: string, limit = 50) {
  const r = await pool.query<{
    email: string;
    first_name: string | null;
    status: string;
    exit_reason: string | null;
    step_index: number;
    next_at: string;
    started_at: string;
  }>(`SELECT email, first_name, status, exit_reason, step_index, next_at, started_at FROM email_flow_runs WHERE flow_id = $1::uuid ORDER BY started_at DESC LIMIT $2`, [flowId, limit]);
  return r.rows;
}

/* --------------------------------------------------------------- triggers */

type Person = {
  email: string;
  firstName: string | null;
  key: string;
  at: Date;
  data: Record<string, unknown>;
};

async function stateGet(pool: Pool, tenantId: string, key: string): Promise<string | null> {
  const r = await pool.query<{ value: string | null }>(`SELECT value FROM email_flow_state WHERE tenant_id = $1::uuid AND key = $2`, [tenantId, key]);
  return r.rows[0]?.value ?? null;
}
async function stateSet(pool: Pool, tenantId: string, key: string, value: string): Promise<void> {
  await pool.query(
    `INSERT INTO email_flow_state (tenant_id, key, value, updated_at) VALUES ($1::uuid, $2, $3, now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, key, value],
  );
}

const productUrl = (handle: string | null | undefined) => (handle ? `https://shopcarbon.com/products/${handle}` : "https://shopcarbon.com");

type ShopOrder = {
  id: string;
  name: string;
  processedAt: string;
  cancelledAt: string | null;
  email: string | null;
  customer: { firstName: string | null; numberOfOrders: string } | null;
  discountCodes: string[];
  currentTotalPriceSet: { shopMoney: { amount: string } };
  lineItems: {
    nodes: {
      title: string;
      quantity: number;
      image: { url: string } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } };
      product: { handle: string } | null;
    }[];
  };
};

/** Shopify orders since the cursor (first time: the last 400 days, so win-back knows who lapsed). */
async function pollShopifyOrders(pool: Pool, tenantId: string): Promise<(Person & { first: boolean })[]> {
  const ctx = await welcomeShopCtx();
  if (!ctx) return [];
  const since = (await stateGet(pool, tenantId, "shopify_orders_at")) ?? new Date(Date.now() - BACKFILL_DAYS * 86_400_000).toISOString();
  const out: (Person & { first: boolean })[] = [];
  let after: string | null = null;
  let newest = since;
  for (let page = 0; page < 60; page++) {
    const d: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopOrder[];
      };
    } = await welcomeGql(
      ctx,
      `query FlowOrders($after: String, $q: String) { orders(first: 100, after: $after, sortKey: PROCESSED_AT, query: $q) {
         pageInfo { hasNextPage endCursor }
         nodes { id name processedAt cancelledAt email discountCodes
           customer { firstName numberOfOrders }
           currentTotalPriceSet { shopMoney { amount } }
           lineItems(first: 12) { nodes { title quantity image { url } originalUnitPriceSet { shopMoney { amount } } product { handle } } } } } }`,
      { after, q: `processed_at:>='${since}'` },
    );
    for (const o of d.orders.nodes) {
      if (o.processedAt > newest) newest = o.processedAt;
      const email = normalizeEmail(o.email);
      if (!email || o.cancelledAt) continue;
      await pool.query(
        `INSERT INTO email_orders_seen (source, order_id, tenant_id, email, name, total, codes, processed_at) VALUES ('shopify', $1, $2::uuid, $3, $4, $5, $6, $7)
         ON CONFLICT (source, order_id) DO NOTHING`,
        [o.id, tenantId, email, o.name, Number(o.currentTotalPriceSet.shopMoney.amount) || 0, o.discountCodes ?? [], o.processedAt],
      );
      const items: ProductItem[] = o.lineItems.nodes
        .filter((l) => l.image?.url)
        .map((l, i) => ({
          id: `${o.id}-${i}`,
          title: l.title,
          price: Number(l.originalUnitPriceSet.shopMoney.amount) || 0,
          compareAt: null,
          image: l.image!.url,
          url: productUrl(l.product?.handle),
          set: null,
        }));
      out.push({
        email,
        firstName: o.customer?.firstName ?? null,
        key: `shopify:${o.id}`,
        at: new Date(o.processedAt),
        data: { items, orderName: o.name, where: "online" },
        first: Number(o.customer?.numberOfOrders ?? 0) <= 1,
      });
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  await stateSet(pool, tenantId, "shopify_orders_at", newest);
  return out;
}

/** Carbon POS sales (the store) with a customer email. */
async function pollPosSales(pool: Pool, tenantId: string): Promise<(Person & { first: boolean })[]> {
  const cursor = Number((await stateGet(pool, tenantId, "pos_sale_id")) ?? 0);
  const r = await pool
    .query<{
      id: number;
      sale_number: string;
      total_amount: string;
      completed_at: Date | null;
      created_at: Date;
      email: string | null;
      first_name: string | null;
      customer_id: number;
      earlier: number;
    }>(
      `SELECT s.id, s.sale_number, s.total_amount::text, s.completed_at, s.created_at, c.email, c.first_name, s.customer_id,
              (SELECT count(*)::int FROM pos_sales e WHERE e.customer_id = s.customer_id AND e.id < s.id AND e.status = 'completed') AS earlier
         FROM pos_sales s JOIN pos_customers c ON c.id = s.customer_id
        WHERE s.id > $1 AND s.status = 'completed' AND s.voided_at IS NULL ORDER BY s.id LIMIT 500`,
      [cursor],
    )
    .catch(() => ({ rows: [] as never[] }));
  const out: (Person & { first: boolean })[] = [];
  let last = cursor;
  for (const s of r.rows) {
    last = Math.max(last, s.id);
    const email = normalizeEmail(s.email);
    if (!email) continue;
    const at = s.completed_at ?? s.created_at;
    await pool.query(`INSERT INTO email_orders_seen (source, order_id, tenant_id, email, name, total, processed_at) VALUES ('pos', $1, $2::uuid, $3, $4, $5, $6) ON CONFLICT (source, order_id) DO NOTHING`, [
      String(s.id),
      tenantId,
      email,
      s.sale_number,
      Number(s.total_amount) || 0,
      at,
    ]);
    out.push({
      email,
      firstName: s.first_name,
      key: `pos:${s.id}`,
      at,
      data: { items: [], orderName: s.sale_number, where: "store" },
      first: s.earlier === 0,
    });
  }
  if (last !== cursor) await stateSet(pool, tenantId, "pos_sale_id", String(last));
  return out;
}

type ShopCheckout = {
  id: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  abandonedCheckoutUrl: string;
  customer: {
    firstName: string | null;
    defaultEmailAddress: { emailAddress: string } | null;
  } | null;
  lineItems: {
    nodes: {
      title: string;
      quantity: number;
      image: { url: string } | null;
      originalUnitPriceSet: { shopMoney: { amount: string } } | null;
      product: { handle: string } | null;
    }[];
  };
};

async function pollCheckouts(pool: Pool, tenantId: string, since: Date): Promise<Person[]> {
  const ctx = await welcomeShopCtx();
  if (!ctx) return [];
  const from = (await stateGet(pool, tenantId, "shopify_checkouts_at")) ?? since.toISOString();
  const out: Person[] = [];
  let newest = from;
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: {
      abandonedCheckouts: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: ShopCheckout[];
      };
    } = await welcomeGql(
      ctx,
      `query FlowCheckouts($after: String, $q: String) { abandonedCheckouts(first: 100, after: $after, query: $q) {
         pageInfo { hasNextPage endCursor }
         nodes { id createdAt updatedAt completedAt abandonedCheckoutUrl
           customer { firstName defaultEmailAddress { emailAddress } }
           lineItems(first: 12) { nodes { title quantity image { url } originalUnitPriceSet { shopMoney { amount } } product { handle } } } } } }`,
      { after, q: `updated_at:>='${from}'` },
    );
    for (const c of d.abandonedCheckouts.nodes) {
      if (c.updatedAt > newest) newest = c.updatedAt;
      const email = normalizeEmail(c.customer?.defaultEmailAddress?.emailAddress);
      if (!email || c.completedAt) continue;
      const items: ProductItem[] = c.lineItems.nodes
        .filter((l) => l.image?.url)
        .map((l, i) => ({
          id: `${c.id}-${i}`,
          title: l.title,
          price: Number(l.originalUnitPriceSet?.shopMoney.amount ?? 0) || 0,
          compareAt: null,
          image: l.image!.url,
          url: productUrl(l.product?.handle),
          set: null,
        }));
      out.push({
        email,
        firstName: c.customer?.firstName ?? null,
        key: `checkout:${c.id}`,
        at: new Date(c.createdAt),
        data: { items, checkoutUrl: c.abandonedCheckoutUrl },
      });
    }
    if (!d.abandonedCheckouts.pageInfo.hasNextPage) break;
    after = d.abandonedCheckouts.pageInfo.endCursor;
  }
  await stateSet(pool, tenantId, "shopify_checkouts_at", newest);
  return out;
}

/** Website sign-ups (Email Popup + footer form), with their welcome code. */
async function pollSignups(pool: Pool, tenantId: string): Promise<Person[]> {
  const cursor = Number((await stateGet(pool, tenantId, "signup_id")) ?? 0);
  const r = await pool
    .query<{
      id: number;
      email: string;
      code: string | null;
      percent_off: number | null;
      ends_at: Date | null;
      created_at: Date;
    }>(`SELECT id, email, code, percent_off, ends_at, created_at FROM welcome_signups WHERE id > $1 ORDER BY id LIMIT 500`, [cursor])
    .catch(() => ({ rows: [] as never[] }));
  let last = cursor;
  const out: Person[] = [];
  for (const s of r.rows) {
    last = Math.max(last, s.id);
    const email = normalizeEmail(s.email);
    if (!email) continue;
    out.push({
      email,
      firstName: null,
      key: `signup:${s.id}`,
      at: s.created_at,
      data: {
        code: s.code,
        percent: s.percent_off,
        codeEnds: s.ends_at?.toISOString() ?? null,
      },
    });
  }
  if (last !== cursor) await stateSet(pool, tenantId, "signup_id", String(last));
  return out;
}

/** People whose last order (online or store) was `days` ago, give or take 3 days. */
async function lapsed(pool: Pool, tenantId: string, days: number): Promise<Person[]> {
  const r = await pool.query<{ email: string; last: Date }>(
    `SELECT email, max(processed_at) AS last FROM email_orders_seen WHERE tenant_id = $1::uuid GROUP BY email
      HAVING max(processed_at) < now() - make_interval(days => $2::int) AND max(processed_at) >= now() - make_interval(days => $2::int + 3)`,
    [tenantId, days],
  );
  return r.rows.map((x) => ({
    email: x.email,
    firstName: null,
    key: `winback:${x.email}:${x.last.toISOString().slice(0, 10)}`,
    at: new Date(),
    data: {},
  }));
}

/**
 * Known shoppers (an email from a sign-up, a login or an order — Visitors) who looked at product
 * pages in a visit between `hours` and 48 h ago and added nothing to the cart, checked out or ordered
 * since. One run per visit; the email shows the products they looked at (still in stock).
 */
export async function browsed(pool: Pool, hours: number, loadCatalog?: () => Promise<{ id: string; handle: string; title: string; price: number; compareAt: number | null; image: string | null; url: string }[]>): Promise<Person[]> {
  const r = await pool
    .query<{ visitor_id: string; visit: number; email: string; name: string | null; handles: string[]; last: Date }>(
      `SELECT v.visitor_id, e.visit, v.email, v.customer_name AS name, array_agg(DISTINCT e.detail->>'product') AS handles, max(e.at) AS last
         FROM visitor_events e JOIN visitors v ON v.visitor_id = e.visitor_id
        WHERE v.email IS NOT NULL AND e.kind = 'view' AND e.detail ? 'product'
          AND e.at > now() - interval '48 hours'
        GROUP BY v.visitor_id, e.visit, v.email, v.customer_name
       HAVING max(e.at) < now() - make_interval(hours => $1::int)
          AND NOT EXISTS (SELECT 1 FROM visitor_events x WHERE x.visitor_id = v.visitor_id AND x.kind IN ('cart_add','checkout','order') AND x.at > min(e.at))`,
      [hours],
    )
    .catch(() => ({ rows: [] as never[] }));
  if (!r.rows.length) return [];
  const { inStockCatalog } = await import("./catalog");
  const catalog = await (loadCatalog ?? inStockCatalog)().catch(() => []);
  const byHandle = new Map(catalog.map((p) => [p.handle, p]));
  const out: Person[] = [];
  for (const x of r.rows) {
    const email = normalizeEmail(x.email);
    if (!email) continue;
    const items: ProductItem[] = x.handles
      .map((h) => byHandle.get(h))
      .filter((p): p is NonNullable<typeof p> => !!p && !!p.image)
      .slice(0, 6)
      .map((p) => ({ id: p.id, title: p.title, price: p.price, compareAt: p.compareAt, image: p.image, url: p.url, set: null }));
    if (!items.length) continue; // nothing they looked at is still in stock
    out.push({ email, firstName: x.name?.split(/\s+/)[0] ?? null, key: `browse:${x.visitor_id}:${x.visit}`, at: x.last, data: { items } });
  }
  return out;
}

/** Online orders that were shipped (fulfilled) since the cursor, with the tracking link. */
async function pollShipped(pool: Pool, tenantId: string): Promise<Person[]> {
  const ctx = await welcomeShopCtx();
  if (!ctx) return [];
  const since = (await stateGet(pool, tenantId, "shopify_shipped_at")) ?? new Date(Date.now() - 86_400_000).toISOString();
  const out: Person[] = [];
  let newest = since;
  let after: string | null = null;
  for (let page = 0; page < 10; page++) {
    const d: {
      orders: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { id: string; name: string; email: string | null; updatedAt: string; displayFulfillmentStatus: string; customer: { firstName: string | null } | null; fulfillments: { createdAt: string; trackingInfo: { url: string | null }[] }[]; lineItems: { nodes: { title: string; image: { url: string } | null; originalUnitPriceSet: { shopMoney: { amount: string } }; product: { handle: string } | null }[] } }[];
      };
    } = await welcomeGql(
      ctx,
      `query FlowShipped($after: String, $q: String) { orders(first: 100, after: $after, sortKey: UPDATED_AT, query: $q) {
         pageInfo { hasNextPage endCursor }
         nodes { id name email updatedAt displayFulfillmentStatus customer { firstName }
           fulfillments(first: 5) { createdAt trackingInfo(first: 1) { url } }
           lineItems(first: 12) { nodes { title image { url } originalUnitPriceSet { shopMoney { amount } } product { handle } } } } } }`,
      { after, q: `updated_at:>='${since}' fulfillment_status:shipped` },
    );
    for (const o of d.orders.nodes) {
      if (o.updatedAt > newest) newest = o.updatedAt;
      const email = normalizeEmail(o.email);
      const f = o.fulfillments[0];
      if (!email || !f) continue;
      const items: ProductItem[] = o.lineItems.nodes
        .filter((l) => l.image?.url)
        .map((l, i) => ({ id: `${o.id}-s${i}`, title: l.title, price: Number(l.originalUnitPriceSet.shopMoney.amount) || 0, compareAt: null, image: l.image!.url, url: productUrl(l.product?.handle), set: null }));
      out.push({ email, firstName: o.customer?.firstName ?? null, key: `shipped:${o.id}`, at: new Date(f.createdAt), data: { items, orderName: o.name, trackingUrl: f.trackingInfo[0]?.url ?? null } });
    }
    if (!d.orders.pageInfo.hasNextPage) break;
    after = d.orders.pageInfo.endCursor;
  }
  await stateSet(pool, tenantId, "shopify_shipped_at", newest);
  return out;
}

/** People whose birthday is today in Orlando (from Rewards), once a year each. */
async function birthdaysToday(pool: Pool, tenantId: string): Promise<Person[]> {
  const r = await pool.query<{ email: string; first_name: string | null; y: string }>(
    `SELECT email, first_name, to_char(now() AT TIME ZONE 'America/New_York', 'YYYY') AS y FROM email_contacts
      WHERE tenant_id = $1::uuid AND birthday IS NOT NULL
        AND to_char(birthday, 'MM-DD') = to_char(now() AT TIME ZONE 'America/New_York', 'MM-DD')`,
    [tenantId],
  );
  return r.rows.map((x) => ({ email: x.email, firstName: x.first_name, key: `birthday:${x.email}:${x.y}`, at: new Date(), data: {} }));
}

/** The contact row (made if new, never changing someone's unsubscribe). */
async function contactFor(pool: Pool, tenantId: string, p: Person): Promise<{ id: string; first_name: string | null } | null> {
  const r = await pool.query<{ id: string; first_name: string | null }>(
    `INSERT INTO email_contacts (tenant_id, email, first_name, unsub_token) VALUES ($1::uuid, $2, $3, $4)
     ON CONFLICT (tenant_id, email) DO UPDATE SET first_name = COALESCE(email_contacts.first_name, EXCLUDED.first_name)
     RETURNING id::text, first_name`,
    [tenantId, p.email, p.firstName, randomBytes(18).toString("base64url")],
  );
  return r.rows[0] ?? null;
}

/** Put a person into a flow (once per trigger key; re-entry rules per flow). */
export async function enroll(pool: Pool, f: FlowRow, p: Person): Promise<boolean> {
  if (!f.live_since || p.at < new Date(f.live_since)) return false;
  const re = f.settings.reentryDays;
  const prev = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM email_flow_runs WHERE flow_id = $1::uuid AND email = $2 ${re == null ? "" : "AND started_at > now() - make_interval(days => $3::int)"}`,
    re == null ? [f.id, p.email] : [f.id, p.email, re],
  );
  if (prev.rows[0].n > 0) return false;
  const c = await contactFor(pool, f.tenant_id, p);
  const ins = await pool.query(
    `INSERT INTO email_flow_runs (flow_id, tenant_id, trigger_key, contact_id, email, first_name, data) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)
     ON CONFLICT (flow_id, trigger_key) DO NOTHING`,
    [f.id, f.tenant_id, p.key, c?.id ?? null, p.email, p.firstName ?? c?.first_name ?? null, JSON.stringify(p.data)],
  );
  return (ins.rowCount ?? 0) > 0;
}

/** Read what happened and put people into the live flows (at most every 5 minutes per store). */
export async function pollTriggers(pool: Pool, tenantId: string, log: (m: string) => void = console.log, force = false): Promise<number> {
  const flows = (
    await pool.query<FlowRow>(
      `SELECT id::text, tenant_id::text, name, kind, trigger, steps, settings, status, live_since, created_at, updated_at FROM email_flows WHERE tenant_id = $1::uuid AND status = 'live' AND archived_at IS NULL`,
      [tenantId],
    )
  ).rows;
  // Orders are read every 5 minutes even with no flow on: segments (best customers, lapsed …) need them.
  const lastPoll = await stateGet(pool, tenantId, "polled_at");
  if (!force && lastPoll && Date.now() - new Date(lastPoll).getTime() < POLL_EVERY_MS) return 0;
  await stateSet(pool, tenantId, "polled_at", new Date().toISOString());
  const types = new Set(flows.map((f) => f.trigger.type));
  let n = 0;
  const into = async (type: Trigger["type"], people: (Person & { first?: boolean; data: Record<string, unknown> })[]) => {
    for (const f of flows.filter((x) => x.trigger.type === type))
      for (const p of people) {
        const t = f.trigger;
        if (t.type === "order") {
          if (t.first && !p.first) continue;
          if (t.where !== "both" && p.data.where !== t.where) continue;
        }
        if (await enroll(pool, f, p)) n++;
      }
  };
  // Orders are always read (the "stop if they ordered" check and win-back need them).
  const orders = [...(await pollShopifyOrders(pool, tenantId).catch((e) => (log(`[flows] Shopify orders: ${e instanceof Error ? e.message : e}`), []))), ...(await pollPosSales(pool, tenantId))];
  if (!flows.length) return 0;
  if (types.has("order")) await into("order", orders);
  if (types.has("abandoned_checkout")) {
    const since = new Date(Math.min(...flows.filter((f) => f.trigger.type === "abandoned_checkout").map((f) => new Date(f.live_since ?? Date.now()).getTime())));
    await into("abandoned_checkout", await pollCheckouts(pool, tenantId, since).catch((e) => (log(`[flows] Shopify checkouts: ${e instanceof Error ? e.message : e}`), [])));
  }
  if (types.has("signup")) await into("signup", await pollSignups(pool, tenantId));
  for (const f of flows) if (f.trigger.type === "winback") for (const p of await lapsed(pool, tenantId, f.trigger.days)) if (await enroll(pool, f, p)) n++;
  if (types.has("wishlist") || types.has("back_in_stock") || types.has("price_drop")) {
    const W = await import("./wishlists");
    await W.syncWishlists(pool, tenantId).catch((e) => log(`[flows] wishlists: ${e instanceof Error ? e.message : e}`));
    for (const f of flows) {
      const t = f.trigger;
      const people = t.type === "wishlist" ? await W.wishlistIdle(pool, tenantId, t.days) : t.type === "back_in_stock" ? await W.backInStock(pool, tenantId) : t.type === "price_drop" ? await W.priceDrop(pool, tenantId) : [];
      for (const p of people) if (await enroll(pool, f, p)) n++;
    }
  }
  for (const f of flows) if (f.trigger.type === "browse_abandon") for (const p of await browsed(pool, f.trigger.hours)) if (await enroll(pool, f, p)) n++;
  if (types.has("shipped")) await into("shipped", await pollShipped(pool, tenantId).catch((e) => (log(`[flows] Shopify shipments: ${e instanceof Error ? e.message : e}`), [])));
  if (types.has("birthday")) for (const f of flows.filter((x) => x.trigger.type === "birthday")) for (const p of await birthdaysToday(pool, tenantId)) if (await enroll(pool, f, p)) n++;
  if (n) log(`[flows] ${n} new ${n === 1 ? "person" : "people"} in flows`);
  return n;
}

/* ------------------------------------------------------------------ steps */

type RunRow = {
  id: string;
  flow_id: string;
  tenant_id: string;
  contact_id: string | null;
  email: string;
  first_name: string | null;
  data: {
    items?: ProductItem[];
    checkoutUrl?: string;
    trackingUrl?: string | null;
    orderName?: string;
    code?: string | null;
    percent?: number | null;
    codeEnds?: string | null;
  };
  step_index: number;
  next_at: Date;
  started_at: Date;
};

/** The email's doc with "this person's cart / order" product blocks filled in (null = none in it). */
export function personalDoc(doc: EmailDoc, items: ProductItem[]): EmailDoc | null {
  let has = false;
  const d = structuredClone(doc);
  for (const s of d.sections)
    for (const c of s.cols) {
      c.blocks = c.blocks.filter((b) => {
        if (b.type !== "product" || b.feed !== "cart" || b.source !== "dynamic") return true;
        has = true;
        if (!items.length) return false; // nothing to show (e.g. a store sale): the block is left out
        b.items = items.slice(0, 12);
        b.startAt = 1;
        b.rows = Math.max(1, Math.ceil(Math.min(items.length, 12) / Math.max(1, b.perRow)));
        return true;
      });
    }
  return has ? d : null;
}

async function emailHtml(pool: Pool, designId: string, run: RunRow): Promise<{ html: string } | null> {
  const d = await pool.query<{ html: string | null; editor_doc: unknown }>(`SELECT html, editor_doc FROM email_designs WHERE id = $1::uuid AND archived_at IS NULL`, [designId]);
  const row = d.rows[0];
  if (!row) return null;
  if (isDoc(row.editor_doc)) {
    const { feedCatalog, fillFeeds } = await import("./editor");
    const cat = await feedCatalog().catch(() => null);
    const own = personalDoc(cat ? fillFeeds(row.editor_doc, cat) : row.editor_doc, run.data.items ?? []);
    if (own)
      return {
        html: editorHtml(
          own,
          await loadPics(
            pool,
            picSources(own).map((s) => s.key),
          ),
        ),
      };
  }
  return row.html ? { html: row.html } : null;
}

async function advance(pool: Pool, runId: string, stepIndex: number, nextAt: Date, done: boolean): Promise<void> {
  await pool.query(`UPDATE email_flow_runs SET step_index = $2, next_at = $3, status = CASE WHEN $4 THEN 'done' ELSE status END, updated_at = now() WHERE id = $1::bigint`, [runId, stepIndex, nextAt, done]);
}

async function exitRun(pool: Pool, runId: string, why: string): Promise<void> {
  await pool.query(`UPDATE email_flow_runs SET status = 'exited', exit_reason = $2, updated_at = now() WHERE id = $1::bigint`, [runId, why]);
}

async function skip(pool: Pool, run: RunRow, step: EmailStep, why: string): Promise<void> {
  await pool.query(`INSERT INTO email_flow_sends (run_id, flow_id, step_id, contact_id, email, status, error) VALUES ($1::bigint, $2::uuid, $3, $4, $5, 'skipped', $6) ON CONFLICT (run_id, step_id) DO NOTHING`, [
    run.id,
    run.flow_id,
    step.id,
    run.contact_id,
    run.email,
    why,
  ]);
}

/** Walk every person whose next step is due. */
export async function runFlowSteps(pool: Pool, log: (m: string) => void = console.log, now: () => Date = () => new Date()): Promise<{ sent: number; skipped: number; exited: number }> {
  const out = { sent: 0, skipped: 0, exited: 0 };
  const lock = await pool.connect();
  try {
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('carbon_email_flows')) AS ok`);
    if (!got.rows[0]?.ok) return out;
    const started = Date.now();
    const due = await pool.query<RunRow & { steps: FlowStep[]; settings: FlowSettings; flow_name: string }>(
      `SELECT r.id::text, r.flow_id::text, r.tenant_id::text, r.contact_id::text, r.email, r.first_name, r.data, r.step_index, r.next_at, r.started_at, f.steps, f.settings, f.name AS flow_name
         FROM email_flow_runs r JOIN email_flows f ON f.id = r.flow_id
        WHERE r.status = 'active' AND r.next_at <= $1 AND f.status = 'live' AND f.archived_at IS NULL
        ORDER BY r.next_at LIMIT 300`,
      [now()],
    );
    const settingsBy = new Map<string, Awaited<ReturnType<typeof getEmailSettings>>>();
    let leftToday: number | null = null;
    for (const run of due.rows) {
      if (Date.now() - started > TICK_BUDGET_MS) break;
      let i = run.step_index;
      let stopHere = false;
      while (!stopHere) {
        const step = run.steps[i];
        if (!step) {
          await advance(pool, run.id, i, now(), true);
          break;
        }
        if (step.type === "wait") {
          await advance(pool, run.id, i + 1, new Date(now().getTime() + waitMs(step)), false);
          stopHere = true;
        } else if (step.type === "stop") {
          const hit =
            step.if === "ordered"
              ? await pool.query(`SELECT 1 FROM email_orders_seen WHERE tenant_id = $1::uuid AND email = $2 AND processed_at > $3 LIMIT 1`, [run.tenant_id, run.email, run.started_at])
              : await pool.query(`SELECT 1 FROM email_flow_sends WHERE run_id = $1::bigint AND clicked_at IS NOT NULL LIMIT 1`, [run.id]);
          if (hit.rowCount) {
            await exitRun(pool, run.id, step.if === "ordered" ? "Placed an order" : "Clicked an email");
            out.exited++;
            stopHere = true;
          } else i++;
        } else {
          // email
          // An email that has to wait comes back to the "stop if" checks just before it, so an
          // order placed overnight still stops the morning email.
          let back = i;
          while (back > 0 && run.steps[back - 1]?.type === "stop") back--;
          const when = inWindow(now(), run.settings);
          if (when.getTime() > now().getTime()) {
            await advance(pool, run.id, back, when, false);
            stopHere = true;
            continue;
          }
          const s = settingsBy.get(run.tenant_id) ?? (await getEmailSettings(pool, run.tenant_id));
          settingsBy.set(run.tenant_id, s);
          if (!s.sendingEnabled) {
            // The store's kill switch: everyone waits on this step.
            await advance(pool, run.id, back, new Date(now().getTime() + 5 * 60_000), false);
            stopHere = true;
            continue;
          }
          const result = await sendStep(pool, run, step, s, leftToday, log);
          if (result.kind === "wait") {
            await advance(pool, run.id, back, new Date(now().getTime() + 60_000), false);
            stopHere = true;
            continue;
          }
          if (result.kind === "sent") {
            out.sent++;
            leftToday = result.leftToday;
          } else out.skipped++;
          i++;
          if (Date.now() - started > TICK_BUDGET_MS) {
            await advance(pool, run.id, i, now(), false);
            stopHere = true;
          }
        }
      }
    }
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('carbon_email_flows'))`).catch(() => {});
    lock.release();
  }
  return out;
}

type StepResult = { kind: "sent"; leftToday: number } | { kind: "skipped" } | { kind: "wait" };

async function sendStep(
  pool: Pool,
  run: RunRow & { settings: FlowSettings; flow_name: string },
  step: EmailStep,
  s: Awaited<ReturnType<typeof getEmailSettings>>,
  leftToday: number | null,
  log: (m: string) => void,
): Promise<StepResult> {
  if (!step.live) {
    await skip(pool, run, step, "This email is switched off in the flow");
    return { kind: "skipped" };
  }
  const prior = await pool.query<{ status: string; message_id: string | null }>(`SELECT status, message_id FROM email_flow_sends WHERE run_id = $1::bigint AND step_id = $2`, [run.id, step.id]);
  if (prior.rows[0]) {
    // Already handled (or a crash mid-send: never sent twice).
    if (prior.rows[0].status === "sending")
      await pool.query(`UPDATE email_flow_sends SET status = 'failed', error = 'Interrupted while sending; not retried so nobody gets it twice' WHERE run_id = $1::bigint AND step_id = $2`, [run.id, step.id]);
    return { kind: "skipped" };
  }
  const c = await pool.query<{
    unsub_token: string;
    last_emailed_at: Date | null;
    mailable: boolean;
    subscribed: boolean;
    hard: boolean;
  }>(
    `SELECT unsub_token, last_emailed_at,
            (excluded_reason IS NULL AND unsubscribed_at IS NULL AND bounced_at IS NULL AND complained_at IS NULL AND COALESCE(shopify_marketing, '') <> 'UNSUBSCRIBED') AS mailable,
            (shopify_marketing = 'SUBSCRIBED') AS subscribed,
            (excluded_reason IS NOT NULL OR bounced_at IS NOT NULL OR complained_at IS NOT NULL) AS hard
       FROM email_contacts WHERE tenant_id = $1::uuid AND email = $2`,
    [run.tenant_id, run.email],
  );
  const contact = c.rows[0];
  // Transactional (about their own order): an unsubscribe from marketing does not stop it; bounces,
  // spam complaints and left-out addresses still do.
  const reachable = run.settings.who === "transactional" ? !!contact && !contact.hard : !!contact?.mailable;
  if (!reachable) {
    await skip(pool, run, step, "Unsubscribed, bounced or left out");
    return { kind: "skipped" };
  }
  if (run.settings.who === "subscribed" && !contact.subscribed) {
    await skip(pool, run, step, "Not subscribed to marketing emails");
    return { kind: "skipped" };
  }
  if (run.settings.skipRecentHours > 0 && contact.last_emailed_at && Date.now() - contact.last_emailed_at.getTime() < run.settings.skipRecentHours * 3_600_000) {
    await skip(pool, run, step, `Got another email in the last ${run.settings.skipRecentHours} hours`);
    return { kind: "skipped" };
  }
  if (!step.designId) {
    await skip(pool, run, step, "No email picked for this step");
    return { kind: "skipped" };
  }
  let left = leftToday;
  if (left == null) {
    try {
      left = (await deps.pacing(s)).leftToday;
    } catch (e) {
      log(`[flows] SES account check failed: ${e instanceof Error ? e.message : String(e)}`);
      return { kind: "wait" };
    }
  }
  if (left <= 0) return { kind: "wait" };
  await readyEditorPics(pool, step.designId);
  const body = await emailHtml(pool, step.designId, run);
  if (!body) {
    await skip(pool, run, step, "The picked email no longer exists");
    return { kind: "skipped" };
  }
  // Claim the step before anything leaves (a crash after this never re-sends).
  const claim = await pool.query(`INSERT INTO email_flow_sends (run_id, flow_id, step_id, contact_id, email, status) VALUES ($1::bigint, $2::uuid, $3, $4, $5, 'sending') ON CONFLICT (run_id, step_id) DO NOTHING`, [
    run.id,
    run.flow_id,
    step.id,
    run.contact_id,
    run.email,
  ]);
  if (!claim.rowCount) return { kind: "skipped" };
  try {
    let code: string | null = null;
    let offer: Offer | null = null;
    if (step.offer) {
      offer = {
        kind: step.offer.kind,
        amount: step.offer.amount,
        minSubtotal: step.offer.minSubtotal,
        prefix: "CARBON",
        endsAt: new Date(Date.now() + step.offer.days * 86_400_000).toISOString(),
      };
      const made = await deps.code({
        name: `${run.flow_name} · ${step.name}`,
        offer,
      });
      code = made.code;
      await pool.query(`UPDATE email_flow_sends SET code = $3, discount_gid = $4 WHERE run_id = $1::bigint AND step_id = $2`, [run.id, step.id, made.code, made.gid]);
    } else if (run.data.code) {
      // The welcome code from the sign-up (Welcome flow).
      code = run.data.code;
      if (run.data.percent && run.data.codeEnds)
        offer = {
          kind: "percent",
          amount: run.data.percent,
          minSubtotal: null,
          prefix: "WELCOME",
          endsAt: run.data.codeEnds,
        };
    }
    const html = wrapEmail({
      designHtml: body.html,
      subject: step.subject,
      preheader: step.preheader,
      postalAddress: s.postalAddress,
      languages: ["en"],
    });
    const values = {
      ...mergeValuesFor({
        firstName: run.first_name,
        code,
        offer,
        unsubToken: contact.unsub_token,
      }),
      checkout_url: run.data.checkoutUrl ?? "",
      order_name: run.data.orderName ?? "",
      tracking_url: run.data.trackingUrl ?? "",
    };
    const filled = fillMergeTags(html, values);
    const subject = fillMergeTags(step.subject, values)
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+,/g, ",")
      .trim();
    const mid = await deps.send(s, {
      to: run.email,
      subject,
      html: filled,
      text: htmlToText(filled),
      unsub: unsubscribeUrl(contact.unsub_token),
      tags: [
        { name: "flow", value: run.flow_id },
        { name: "step", value: step.id },
      ],
    });
    await pool.query(`UPDATE email_flow_sends SET status = 'sent', message_id = $3, sent_at = now() WHERE run_id = $1::bigint AND step_id = $2`, [run.id, step.id, mid]);
    await pool.query(`UPDATE email_contacts SET last_emailed_at = now() WHERE tenant_id = $1::uuid AND email = $2`, [run.tenant_id, run.email]);
    return { kind: "sent", leftToday: left - 1 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const retry = (e instanceof SesSendError && (e.kind === "throttle" || e.kind === "account")) || /throttl|rate|too many|timeout|5\d\d|fetch failed/i.test(msg);
    if (retry) {
      // Nothing left: try this step again on a later tick.
      await pool.query(`DELETE FROM email_flow_sends WHERE run_id = $1::bigint AND step_id = $2 AND message_id IS NULL`, [run.id, step.id]);
      log(`[flows] waiting to send (${msg.slice(0, 120)})`);
      return { kind: "wait" };
    }
    await pool.query(`UPDATE email_flow_sends SET status = 'failed', error = $3 WHERE run_id = $1::bigint AND step_id = $2`, [run.id, step.id, msg.slice(0, 500)]);
    return { kind: "skipped" };
  }
}

/** Everything a tick does for flows. */
export async function runFlows(pool: Pool, log: (m: string) => void = console.log): Promise<{ entered: number; sent: number; skipped: number; exited: number }> {
  // Every store that uses Email (settings saved), so the order history stays current for segments too.
  const tenants = await pool.query<{ tenant_id: string }>(
    `SELECT tenant_id::text FROM email_settings UNION SELECT DISTINCT tenant_id::text FROM email_flows WHERE status = 'live' AND archived_at IS NULL`,
  );
  let entered = 0;
  for (const t of tenants.rows) entered += await pollTriggers(pool, t.tenant_id, log).catch((e) => (log(`[flows] triggers: ${e instanceof Error ? e.message : String(e)}`), 0));
  const steps = await runFlowSteps(pool, log);
  return { entered, ...steps };
}

/** "Send a test" of one flow email to the owner (sample cart, sample code; no Shopify code made). */
export async function sendFlowTest(pool: Pool, tenantId: string, input: { flowId: string; stepId: string; to: string }): Promise<string> {
  const f = await getFlow(pool, tenantId, input.flowId);
  const step = f?.steps.find((x): x is EmailStep => x.id === input.stepId && x.type === "email");
  if (!f || !step) throw new Error("Email step not found");
  if (!step.designId) throw new Error("Pick an email for this step first");
  const s = await getEmailSettings(pool, tenantId);
  const sample = await pool.query<{ items: ProductItem[] }>(
    `SELECT data->'items' AS items FROM email_flow_runs WHERE flow_id = $1::uuid AND jsonb_array_length(COALESCE(data->'items','[]')) > 0 ORDER BY id DESC LIMIT 1`,
    [f.id],
  );
  const items = sample.rows[0]?.items ?? [];
  await readyEditorPics(pool, step.designId);
  const fake: RunRow = {
    id: "0",
    flow_id: f.id,
    tenant_id: tenantId,
    contact_id: null,
    email: input.to,
    first_name: "Maria",
    data: {
      items,
      checkoutUrl: "https://shopcarbon.com/cart",
      orderName: "#1000",
    },
    step_index: 0,
    next_at: new Date(),
    started_at: new Date(),
  };
  const body = await emailHtml(pool, step.designId, fake);
  if (!body) throw new Error("The picked email no longer exists");
  const offer: Offer | null = step.offer
    ? {
        kind: step.offer.kind,
        amount: step.offer.amount,
        minSubtotal: step.offer.minSubtotal,
        prefix: "CARBON",
        endsAt: new Date(Date.now() + step.offer.days * 86_400_000).toISOString(),
      }
    : null;
  const html = wrapEmail({
    designHtml: body.html,
    subject: step.subject,
    preheader: step.preheader,
    postalAddress: s.postalAddress,
    languages: ["en"],
  });
  const values = {
    ...mergeValuesFor({
      firstName: "Maria",
      code: offer || f.trigger.type === "signup" ? "CARBON-TEST00" : null,
      offer,
      unsubToken: "test",
    }),
    checkout_url: "https://shopcarbon.com/cart",
    order_name: "#1000",
    tracking_url: "https://shopcarbon.com",
  };
  const filled = fillMergeTags(html, values);
  return deps.send(s, {
    to: input.to,
    subject: `[TEST] ${fillMergeTags(step.subject, values).replace(/&amp;/g, "&").replace(/&#39;/g, "'")}`,
    html: filled,
    text: htmlToText(filled),
    unsub: unsubscribeUrl("test"),
    tags: [
      { name: "flow", value: f.id },
      { name: "kind", value: "test" },
    ],
  });
}
