/**
 * CarbonWMS Email — the contact list.
 *
 * "Sync contacts" joins the Rewards customers (pos_customers) and the Shopify
 * customers into email_contacts, one row per address:
 *  - fake (@example.com, test…), staff and typo addresses are kept but marked
 *    excluded — never mailed;
 *  - Shopify "unsubscribed", the Email Popup unsubscribe list, bounces and
 *    spam complaints are never mailed again, whatever a later sync says;
 *  - Rewards' contact_email_ok is NOT used: it is false for everyone because
 *    the 2021 store import never filled it (checked 2026-11-07), and US law
 *    (CAN-SPAM) allows emailing past customers with an unsubscribe link.
 */
import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { cleanFirstName, exclusionReason, normalizeEmail } from "./rules";

type Incoming = {
  email: string;
  first: string | null;
  last: string | null;
  rewards: boolean;
  shopify: boolean;
  gid: string | null;
  marketing: string | null;
  since: string | null;
  birthday: string | null;
};

async function shopifyCustomers(): Promise<{ email: string; first: string | null; last: string | null; gid: string; marketing: string | null; since: string }[]> {
  const ctx = await welcomeShopCtx();
  if (!ctx) throw new Error("Shopify is not connected");
  const out: { email: string; first: string | null; last: string | null; gid: string; marketing: string | null; since: string }[] = [];
  let after: string | null = null;
  for (let page = 0; page < 200; page++) {
    const d: {
      customers: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { id: string; firstName: string | null; lastName: string | null; createdAt: string; defaultEmailAddress: { emailAddress: string; marketingState: string } | null }[];
      };
    } = await welcomeGql(
      ctx,
      `query Cust($after: String) { customers(first: 250, after: $after) {
         pageInfo { hasNextPage endCursor }
         nodes { id firstName lastName createdAt defaultEmailAddress { emailAddress marketingState } } } }`,
      { after },
    );
    for (const n of d.customers.nodes) {
      const e = normalizeEmail(n.defaultEmailAddress?.emailAddress);
      if (e) out.push({ email: e, first: n.firstName, last: n.lastName, gid: n.id, marketing: n.defaultEmailAddress?.marketingState ?? null, since: n.createdAt.slice(0, 10) });
    }
    if (!d.customers.pageInfo.hasNextPage) break;
    after = d.customers.pageInfo.endCursor;
  }
  return out;
}

export type SyncResult = { total: number; added: number; rewards: number; shopify: number; excluded: number; unsubscribed: number };

export async function syncContacts(pool: Pool, tenantId: string): Promise<SyncResult> {
  const map = new Map<string, Incoming>();
  const pos = await pool.query<{ email: string | null; first_name: string | null; last_name: string | null; created_at: Date | null; birthday: Date | string | null; shopify_customer_gid: string | null }>(
    `SELECT email, first_name, last_name, created_at, birthday, shopify_customer_gid FROM pos_customers WHERE email ~ '@'`,
  );
  for (const r of pos.rows) {
    const e = normalizeEmail(r.email);
    if (!e) continue;
    const since = r.created_at ? r.created_at.toISOString().slice(0, 10) : null;
    const bday = r.birthday ? new Date(r.birthday).toISOString().slice(0, 10) : null;
    const cur = map.get(e);
    if (cur) {
      cur.first ??= r.first_name;
      if (since && (!cur.since || since < cur.since)) cur.since = since;
      cur.birthday ??= bday;
      cur.gid ??= r.shopify_customer_gid;
    } else {
      map.set(e, { email: e, first: r.first_name, last: r.last_name, rewards: true, shopify: false, gid: r.shopify_customer_gid, marketing: null, since, birthday: bday });
    }
  }
  const shop = await shopifyCustomers();
  for (const c of shop) {
    const cur = map.get(c.email);
    if (cur) {
      cur.shopify = true;
      cur.gid = c.gid;
      cur.marketing = c.marketing;
      cur.first ??= c.first;
      cur.last ??= c.last;
      if (!cur.since || c.since < cur.since) cur.since = c.since;
    } else {
      map.set(c.email, { email: c.email, first: c.first, last: c.last, rewards: false, shopify: true, gid: c.gid, marketing: c.marketing, since: c.since, birthday: null });
    }
  }

  const before = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM email_contacts WHERE tenant_id = $1::uuid`, [tenantId]);
  const rows = [...map.values()];
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await pool.query(
      `INSERT INTO email_contacts (tenant_id, email, first_name, last_name, in_rewards, in_shopify, shopify_customer_gid, shopify_marketing,
                                   customer_since, birthday, unsub_token, excluded_reason, synced_at,
                                   unsubscribed_at, unsubscribe_source)
       SELECT $1::uuid, x.email, x.first, x.last, x.rewards, x.shopify, x.gid, x.marketing, x.since::date, x.birthday::date, x.token, x.excluded, now(),
              CASE WHEN x.marketing = 'UNSUBSCRIBED' THEN now() END, CASE WHEN x.marketing = 'UNSUBSCRIBED' THEN 'shopify' END
         FROM jsonb_to_recordset($2::jsonb) AS x(email text, first text, last text, rewards boolean, shopify boolean, gid text, marketing text,
                                                 since text, birthday text, token text, excluded text)
       ON CONFLICT (tenant_id, email) DO UPDATE SET
         first_name = COALESCE(EXCLUDED.first_name, email_contacts.first_name),
         last_name = COALESCE(EXCLUDED.last_name, email_contacts.last_name),
         in_rewards = EXCLUDED.in_rewards, in_shopify = EXCLUDED.in_shopify,
         shopify_customer_gid = COALESCE(EXCLUDED.shopify_customer_gid, email_contacts.shopify_customer_gid),
         shopify_marketing = EXCLUDED.shopify_marketing,
         customer_since = LEAST(EXCLUDED.customer_since, email_contacts.customer_since),
         birthday = COALESCE(EXCLUDED.birthday, email_contacts.birthday),
         excluded_reason = EXCLUDED.excluded_reason,
         -- an unsubscribe is never undone by a sync
         unsubscribed_at = COALESCE(email_contacts.unsubscribed_at, EXCLUDED.unsubscribed_at),
         unsubscribe_source = COALESCE(email_contacts.unsubscribe_source, EXCLUDED.unsubscribe_source),
         synced_at = now()`,
      [
        tenantId,
        JSON.stringify(
          chunk.map((c) => ({
            email: c.email,
            first: cleanFirstName(c.first),
            last: c.last?.trim() || null,
            rewards: c.rewards,
            shopify: c.shopify,
            gid: c.gid,
            marketing: c.marketing,
            since: c.since,
            birthday: c.birthday,
            token: randomBytes(18).toString("base64url"),
            excluded: exclusionReason(c.email),
          })),
        ),
      ],
    );
  }
  // People who unsubscribed from the Email Popup welcome email.
  await pool.query(
    `UPDATE email_contacts c SET unsubscribed_at = w.unsubscribed_at, unsubscribe_source = 'welcome'
       FROM welcome_signups w
      WHERE c.tenant_id = $1::uuid AND c.email = w.email AND w.unsubscribed_at IS NOT NULL AND c.unsubscribed_at IS NULL`,
    [tenantId],
  );
  const after = await pool.query<{ n: string; excluded: string; unsub: string }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE excluded_reason IS NOT NULL) AS excluded,
            count(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS unsub
       FROM email_contacts WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  return {
    total: Number(after.rows[0].n),
    added: Number(after.rows[0].n) - Number(before.rows[0].n),
    rewards: rows.filter((r) => r.rewards).length,
    shopify: rows.filter((r) => r.shopify).length,
    excluded: Number(after.rows[0].excluded),
    unsubscribed: Number(after.rows[0].unsub),
  };
}

/* ------------------------------------------------------------------ audience */

export type Audience = {
  /** all = every mailable contact; subscribed = Shopify "subscribed" only. */
  who: "all" | "subscribed";
  /** Only people who became customers in or after this year. */
  sinceYear?: number | null;
  /** Only people who became customers before this year. */
  beforeYear?: number | null;
  /** Leave out anyone emailed in the last N days. */
  notEmailedDays?: number | null;
  /** Just these addresses (tests). */
  emails?: string[] | null;
};

export function audienceSql(a: Audience, firstParam: number): { where: string; params: unknown[] } {
  const parts = [
    "c.excluded_reason IS NULL",
    "c.unsubscribed_at IS NULL",
    "c.bounced_at IS NULL",
    "c.complained_at IS NULL",
  ];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${firstParam + params.length - 1}`;
  };
  if (a.who === "subscribed") parts.push("c.shopify_marketing = 'SUBSCRIBED'");
  if (a.sinceYear) parts.push(`c.customer_since >= make_date(${p(Math.trunc(a.sinceYear))}::int, 1, 1)`);
  if (a.beforeYear) parts.push(`c.customer_since < make_date(${p(Math.trunc(a.beforeYear))}::int, 1, 1)`);
  if (a.notEmailedDays) parts.push(`(c.last_emailed_at IS NULL OR c.last_emailed_at < now() - make_interval(days => ${p(Math.trunc(a.notEmailedDays))}::int))`);
  if (a.emails?.length) parts.push(`c.email = ANY(${p(a.emails)}::text[])`);
  return { where: parts.join(" AND "), params };
}

export async function audienceCount(pool: Pool, tenantId: string, a: Audience): Promise<number> {
  const q = audienceSql(a, 2);
  const r = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM email_contacts c WHERE c.tenant_id = $1::uuid AND ${q.where}`, [tenantId, ...q.params]);
  return Number(r.rows[0].n);
}

export async function contactSummary(pool: Pool, tenantId: string) {
  const r = await pool.query<Record<string, string | null>>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE excluded_reason IS NULL AND unsubscribed_at IS NULL AND bounced_at IS NULL AND complained_at IS NULL) AS mailable,
            count(*) FILTER (WHERE shopify_marketing = 'SUBSCRIBED' AND excluded_reason IS NULL AND unsubscribed_at IS NULL AND bounced_at IS NULL AND complained_at IS NULL) AS subscribed,
            count(*) FILTER (WHERE excluded_reason = 'fake') AS fake,
            count(*) FILTER (WHERE excluded_reason = 'staff') AS staff,
            count(*) FILTER (WHERE excluded_reason = 'typo') AS typo,
            count(*) FILTER (WHERE unsubscribed_at IS NOT NULL) AS unsubscribed,
            count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced,
            count(*) FILTER (WHERE complained_at IS NOT NULL) AS complained,
            count(*) FILTER (WHERE in_rewards) AS rewards,
            count(*) FILTER (WHERE in_shopify) AS shopify,
            max(synced_at) AS synced_at
       FROM email_contacts WHERE tenant_id = $1::uuid`,
    [tenantId],
  );
  const years = await pool.query<{ y: number | null; n: string }>(
    `SELECT date_part('year', customer_since)::int AS y, count(*) AS n FROM email_contacts
      WHERE tenant_id = $1::uuid AND excluded_reason IS NULL AND unsubscribed_at IS NULL AND bounced_at IS NULL AND complained_at IS NULL
      GROUP BY 1 ORDER BY 1`,
    [tenantId],
  );
  const s = r.rows[0];
  const n = (k: string) => Number(s[k] ?? 0);
  return {
    total: n("total"),
    mailable: n("mailable"),
    subscribed: n("subscribed"),
    excluded: { fake: n("fake"), staff: n("staff"), typo: n("typo") },
    unsubscribed: n("unsubscribed"),
    bounced: n("bounced"),
    complained: n("complained"),
    rewards: n("rewards"),
    shopify: n("shopify"),
    syncedAt: s.synced_at,
    byYear: years.rows.map((y) => ({ year: y.y, count: Number(y.n) })),
  };
}

/** Unsubscribe by token (link page, one-click, or webhook). Also tells Shopify. */
export async function unsubscribeContact(pool: Pool, token: string, source: "link" | "one_click"): Promise<{ ok: boolean; email?: string }> {
  const r = await pool.query<{ id: string; email: string; shopify_customer_gid: string | null; unsubscribed_at: Date | null }>(
    `SELECT id::text, email, shopify_customer_gid, unsubscribed_at FROM email_contacts WHERE unsub_token = $1`,
    [token],
  );
  const c = r.rows[0];
  if (!c) return { ok: false };
  if (!c.unsubscribed_at) {
    await pool.query(`UPDATE email_contacts SET unsubscribed_at = now(), unsubscribe_source = $2 WHERE id = $1::bigint`, [c.id, source]);
    await markShopifyUnsubscribed(c.shopify_customer_gid);
  }
  return { ok: true, email: c.email };
}

export async function markShopifyUnsubscribed(gid: string | null): Promise<void> {
  if (!gid) return;
  const ctx = await welcomeShopCtx();
  if (!ctx) return;
  await welcomeGql(
    ctx,
    `mutation($i: CustomerEmailMarketingConsentUpdateInput!) { customerEmailMarketingConsentUpdate(input: $i) { userErrors { message } } }`,
    { i: { customerId: gid, emailMarketingConsent: { marketingState: "UNSUBSCRIBED" } } },
  ).catch((e) => console.warn("[email] shopify unsubscribe", e instanceof Error ? e.message : e));
}
