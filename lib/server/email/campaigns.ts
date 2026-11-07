/**
 * CarbonWMS Email — campaigns: approve, send, protect, measure.
 *
 * Sending (runEmailSends, from the worker's tick every minute):
 *  - newest customers first, so the addresses most likely to work go out
 *    before the 2021–2022 ones;
 *  - each person: re-checked against the suppression list, their own Shopify
 *    code made just before their email (one discount per person, single use,
 *    $X off once per order, ends on the campaign's date, combines with
 *    nothing — the same setup the Email Popup codes use in production),
 *    then the email through Amazon SES. SES has no idempotency key, so a row
 *    interrupted mid-send is marked failed (never re-sent) rather than risk
 *    a second email;
 *  - paced to SES's send rate (80% of it) capped by the settings' emails per
 *    minute, and stopping for the day at SES's 24-hour quota;
 *  - auto-pause: after 150 sends, when bounces pass the limit (default 3%) or
 *    spam complaints pass 0.1% — Amazon reviews an account at 5% bounces /
 *    0.1% complaints.
 *
 * Results: SES events through SNS (delivered / opened / clicked / bounced /
 * complained) land on each recipient; code use and sales are read back from
 * Shopify every 3 hours (refreshResults).
 */
import type { Pool, PoolClient } from "pg";
import { welcomeGql, welcomeShopCtx, userErrorText } from "@/lib/server/welcome/config";
import { audienceSql, markShopifyUnsubscribed, type Audience } from "./contacts";
import { INSTAGRAM_URL, SHOP_URL, SesSendError, WMS_BASE, getEmailSettings, senderReady, sesPacing, sesSend, type EmailSettings } from "./config";
import { fillMergeTags, htmlToText, longDay, personalCode, shouldPause, usedMergeTags, wrapEmail, type MergeValues } from "./rules";

export type Offer = { amount: number; endsAt: string; minSubtotal: number | null; prefix: string };

export type CampaignRow = {
  id: string;
  name: string;
  design_id: string | null;
  subject: string;
  preheader: string;
  html: string | null;
  audience: Audience;
  offer: Offer | null;
  status: string;
  pause_reason: string | null;
  send_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  results: Record<string, number> | null;
  results_at: Date | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export function unsubscribeUrl(token: string): string {
  return `${WMS_BASE}/api/public/email/unsubscribe?t=${encodeURIComponent(token)}`;
}

export function codeUrl(code: string): string {
  return `${SHOP_URL}/discount/${encodeURIComponent(code)}?redirect=%2F`;
}

export function mergeValuesFor(input: { firstName: string | null; code: string | null; offer: Offer | null; unsubToken: string }): MergeValues {
  return {
    first_name: input.firstName ?? "",
    greeting_name: input.firstName ?? "there",
    code: input.code ?? "",
    code_url: input.code ? codeUrl(input.code) : SHOP_URL,
    offer_amount: input.offer ? `$${input.offer.amount % 1 ? input.offer.amount.toFixed(2) : input.offer.amount}` : "",
    offer_ends: input.offer ? longDay(input.offer.endsAt) : "",
    shop_url: SHOP_URL,
    instagram_url: INSTAGRAM_URL,
    unsubscribe_url: unsubscribeUrl(input.unsubToken),
  };
}

/** One person's finished email (subject can use merge tags too). */
export function renderFor(c: { subject: string; html: string }, v: MergeValues): { subject: string; html: string; text: string } {
  const html = fillMergeTags(c.html, v);
  const subject = fillMergeTags(c.subject, v).replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+,/g, ",").trim();
  return { subject, html, text: htmlToText(html) };
}

/* ------------------------------------------------------------------ codes */

export async function createPersonalCode(campaign: { name: string; offer: Offer }): Promise<{ code: string; gid: string }> {
  const ctx = await welcomeShopCtx();
  if (!ctx) throw new Error("Shopify is not connected");
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = personalCode(campaign.offer.prefix);
    const r = await welcomeGql<{ discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: { field?: string[]; message: string }[] } }>(
      ctx,
      `mutation EmailCode($d: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message } }
      }`,
      {
        d: {
          title: `Email · ${campaign.name.slice(0, 60)} · ${code}`,
          code,
          startsAt: new Date().toISOString(),
          endsAt: campaign.offer.endsAt,
          context: { all: "ALL" },
          tags: ["carbon-email"],
          customerGets: {
            value: { discountAmount: { amount: campaign.offer.amount.toFixed(2), appliesOnEachItem: false } },
            items: { all: true },
          },
          ...(campaign.offer.minSubtotal ? { minimumRequirement: { subtotal: { greaterThanOrEqualToSubtotal: campaign.offer.minSubtotal.toFixed(2) } } } : {}),
          appliesOncePerCustomer: true,
          usageLimit: 1,
          combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
        },
      },
    );
    const node = r.discountCodeBasicCreate.codeDiscountNode;
    if (node) return { code, gid: node.id };
    const errs = r.discountCodeBasicCreate.userErrors;
    lastError = userErrorText(errs) || "Shopify did not create the code";
    if (!errs.some((e) => /unique|taken|already/i.test(e.message))) break;
  }
  throw new Error(lastError);
}

/* ---------------------------------------------------------------- campaigns */

export async function getCampaign(pool: Pool, tenantId: string, id: string): Promise<CampaignRow | null> {
  const r = await pool.query<CampaignRow>(`SELECT * FROM email_campaigns WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tenantId]);
  return r.rows[0] ?? null;
}

export async function campaignStats(pool: Pool | PoolClient, id: string) {
  const r = await pool.query<Record<string, string>>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status = 'queued') AS queued,
            count(*) FILTER (WHERE status IN ('sent')) AS sent,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            count(*) FILTER (WHERE status = 'skipped') AS skipped,
            count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
            count(*) FILTER (WHERE opened_at IS NOT NULL) AS opened,
            count(*) FILTER (WHERE clicked_at IS NOT NULL) AS clicked,
            count(*) FILTER (WHERE bounced_at IS NOT NULL) AS bounced,
            count(*) FILTER (WHERE complained_at IS NOT NULL) AS complained,
            count(*) FILTER (WHERE used_at IS NOT NULL) AS used,
            COALESCE(sum(used_total), 0) AS sales
       FROM email_campaign_recipients WHERE campaign_id = $1::uuid`,
    [id],
  );
  const s = r.rows[0];
  const unsub = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM email_campaign_recipients r JOIN email_contacts c ON c.id = r.contact_id
      WHERE r.campaign_id = $1::uuid AND r.sent_at IS NOT NULL AND c.unsubscribed_at >= r.sent_at`,
    [id],
  );
  const n = (k: string) => Number(s[k] ?? 0);
  return {
    total: n("total"),
    queued: n("queued"),
    sent: n("sent"),
    failed: n("failed"),
    skipped: n("skipped"),
    delivered: n("delivered"),
    opened: n("opened"),
    clicked: n("clicked"),
    bounced: n("bounced"),
    complained: n("complained"),
    unsubscribed: Number(unsub.rows[0].n),
    used: n("used"),
    sales: Number(s.sales ?? 0),
  };
}

/** Everything that must be true before a campaign can be approved. */
export async function approvalProblems(pool: Pool, tenantId: string, c: CampaignRow, s: EmailSettings): Promise<string[]> {
  const out: string[] = [];
  if (!c.subject.trim()) out.push("Write a subject line.");
  if (!c.design_id) out.push("Pick an email design.");
  const d = c.design_id ? await pool.query<{ html: string | null; status: string }>(`SELECT html, status FROM email_designs WHERE id = $1::uuid`, [c.design_id]) : null;
  const html = d?.rows[0]?.html ?? null;
  if (c.design_id && !html) out.push("The design has not been converted to an email yet.");
  if (html) {
    const tags = usedMergeTags(html);
    if ((tags.includes("code") || tags.includes("code_url")) && !c.offer) out.push("The email shows a code, so the campaign needs an offer ($ off).");
    if (c.offer && !tags.includes("code")) out.push("The campaign has an offer, but the email never shows {{code}}. Convert the design again or remove the offer.");
  }
  if (c.offer) {
    if (!(c.offer.amount > 0 && c.offer.amount <= 500)) out.push("The offer amount must be between $1 and $500.");
    if (!c.offer.endsAt || new Date(c.offer.endsAt).getTime() < Date.now() + 24 * 3600_000) out.push("The code end date must be at least a day away.");
  }
  if (!s.sendingEnabled) out.push("Sending is switched off in Email → Settings.");
  const v = await senderReady(s);
  if (!v.ok) out.push(v.why ?? "Amazon SES is not ready.");
  else if (v.sandbox) out.push("Amazon SES is still in sandbox mode (it only sends to verified addresses). Request production access in the AWS console first.");
  if (!s.snsTopicArn) out.push("Delivery tracking is not set up. Press \"Set up Amazon SES\" in Email → Settings.");
  const q = audienceSql(c.audience, 2);
  const n = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM email_contacts c WHERE c.tenant_id = $1::uuid AND ${q.where}`, [tenantId, ...q.params]);
  if (Number(n.rows[0].n) === 0) out.push("Nobody matches the audience.");
  return out;
}

/**
 * The people a campaign goes to, frozen at approval: Shopify-subscribed first,
 * then the newest customers, so the addresses most likely to work go out first.
 */
export async function snapshotRecipients(db: Pool | PoolClient, tenantId: string, campaignId: string, audience: Audience): Promise<number> {
  const q = audienceSql(audience, 3);
  const ins = await db.query(
    `INSERT INTO email_campaign_recipients (campaign_id, contact_id, email, first_name, sort_key)
     SELECT $1::uuid, c.id, c.email, c.first_name,
            (row_number() OVER (ORDER BY COALESCE(c.shopify_marketing = 'SUBSCRIBED', false) DESC, c.customer_since DESC NULLS LAST, c.id))::int
       FROM email_contacts c WHERE c.tenant_id = $2::uuid AND ${q.where}
     ON CONFLICT DO NOTHING`,
    [campaignId, tenantId, ...q.params],
  );
  return ins.rowCount ?? 0;
}

/** Approve: freeze the email and the list of people, then wait for send_at. */
export async function approveCampaign(pool: Pool, tenantId: string, id: string, by: string, sendAt: string | null): Promise<{ recipients: number }> {
  const c = await getCampaign(pool, tenantId, id);
  if (!c) throw new Error("Campaign not found");
  if (c.status !== "draft") throw new Error("Only a draft can be approved");
  const s = await getEmailSettings(pool, tenantId);
  const problems = await approvalProblems(pool, tenantId, c, s);
  if (problems.length) throw new Error(problems.join(" "));
  const d = await pool.query<{ html: string }>(`SELECT html FROM email_designs WHERE id = $1::uuid`, [c.design_id]);
  const html = wrapEmail({ designHtml: d.rows[0].html, subject: c.subject, preheader: c.preheader, postalAddress: s.postalAddress });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recipients = await snapshotRecipients(client, tenantId, id, c.audience);
    await client.query(
      `UPDATE email_campaigns SET html = $2, status = 'scheduled', approved_by = $3, approved_at = now(),
              send_at = COALESCE($4::timestamptz, now()), pause_reason = NULL, updated_at = now() WHERE id = $1::uuid`,
      [id, html, by, sendAt],
    );
    await client.query("COMMIT");
    return { recipients };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function setCampaignState(pool: Pool, tenantId: string, id: string, action: "pause" | "resume" | "cancel" | "unapprove"): Promise<void> {
  const c = await getCampaign(pool, tenantId, id);
  if (!c) throw new Error("Campaign not found");
  if (action === "pause") {
    if (!["scheduled", "sending"].includes(c.status)) throw new Error("Only a scheduled or sending campaign can be paused");
    await pool.query(`UPDATE email_campaigns SET status = 'paused', pause_reason = 'Paused by hand', updated_at = now() WHERE id = $1::uuid`, [id]);
  } else if (action === "resume") {
    if (c.status !== "paused") throw new Error("Only a paused campaign can be resumed");
    await pool.query(`UPDATE email_campaigns SET status = CASE WHEN started_at IS NULL THEN 'scheduled' ELSE 'sending' END, pause_reason = NULL, updated_at = now() WHERE id = $1::uuid`, [id]);
  } else if (action === "unapprove") {
    if (!["scheduled", "paused"].includes(c.status) || c.started_at) throw new Error("Only a campaign that has not started can go back to draft");
    await pool.query(`DELETE FROM email_campaign_recipients WHERE campaign_id = $1::uuid`, [id]);
    await pool.query(`UPDATE email_campaigns SET status = 'draft', approved_by = NULL, approved_at = NULL, html = NULL, pause_reason = NULL, updated_at = now() WHERE id = $1::uuid`, [id]);
  } else {
    if (["sent", "cancelled"].includes(c.status)) throw new Error("This campaign is already finished");
    await pool.query(`UPDATE email_campaign_recipients SET status = 'skipped', error = 'Campaign cancelled' WHERE campaign_id = $1::uuid AND status = 'queued'`, [id]);
    await pool.query(`UPDATE email_campaigns SET status = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1::uuid`, [id]);
  }
}

/* ------------------------------------------------------------------ sending */

async function sendOne(s: EmailSettings, input: { to: string; subject: string; html: string; text: string; unsub: string; tags: { name: string; value: string }[] }): Promise<string> {
  return sesSend(s, input);
}

/** A test email to the owner, with a sample code that is NOT created in Shopify. */
export async function sendTest(pool: Pool, tenantId: string, input: { campaignId: string; to: string }): Promise<string> {
  const c = await getCampaign(pool, tenantId, input.campaignId);
  if (!c) throw new Error("Campaign not found");
  const s = await getEmailSettings(pool, tenantId);
  const v = await senderReady(s);
  if (!v.ok) throw new Error(v.why ?? "Amazon SES is not ready");
  const d = c.design_id ? await pool.query<{ html: string | null }>(`SELECT html FROM email_designs WHERE id = $1::uuid`, [c.design_id]) : null;
  const designHtml = c.html ? null : d?.rows[0]?.html;
  if (!c.html && !designHtml) throw new Error("The design has not been converted to an email yet");
  const html = c.html ?? wrapEmail({ designHtml: designHtml!, subject: c.subject, preheader: c.preheader, postalAddress: s.postalAddress });
  const contact = await pool.query<{ first_name: string | null; unsub_token: string }>(
    `SELECT first_name, unsub_token FROM email_contacts WHERE tenant_id = $1::uuid AND email = $2`,
    [tenantId, input.to.toLowerCase()],
  );
  const first = contact.rows[0]?.first_name ?? "Maria";
  const token = contact.rows[0]?.unsub_token ?? "test";
  const sample = c.offer ? `${c.offer.prefix}-TEST00` : null;
  const mail = renderFor({ subject: `[TEST] ${c.subject}`, html }, mergeValuesFor({ firstName: first, code: sample, offer: c.offer, unsubToken: token }));
  return sendOne(s, { to: input.to, ...mail, unsub: unsubscribeUrl(token), tags: [{ name: "campaign", value: c.id }, { name: "kind", value: "test" }] });
}

const TICK_BUDGET_MS = 45_000;

/** Called by the tick: move every due campaign forward for up to ~45 s. */
export async function runEmailSends(pool: Pool, log: (m: string) => void = console.log): Promise<{ sent: number; failed: number }> {
  const lock = await pool.connect();
  let sent = 0;
  let failed = 0;
  try {
    const got = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('carbon_email_send')) AS ok`);
    if (!got.rows[0]?.ok) return { sent, failed };
    // A crash mid-send: SES may or may not have taken the email, so the row is never re-sent.
    await pool.query(`UPDATE email_campaign_recipients SET status = 'failed', error = 'Interrupted while sending; not retried so nobody gets it twice'
                       WHERE status = 'sending' AND message_id IS NULL AND id IN (
                        SELECT r.id FROM email_campaign_recipients r JOIN email_campaigns c ON c.id = r.campaign_id WHERE c.updated_at < now() - interval '10 minutes')`);
    const due = await pool.query<CampaignRow & { tenant_id: string }>(
      `SELECT * FROM email_campaigns WHERE status IN ('scheduled','sending') AND send_at <= now() ORDER BY send_at LIMIT 5`,
    );
    const started = Date.now();
    for (const c of due.rows) {
      const s = await getEmailSettings(pool, c.tenant_id);
      if (!s.sendingEnabled) continue;
      let pace: { perMinute: number; leftToday: number };
      try {
        pace = await sesPacing(s);
      } catch (e) {
        log(`[email] SES account check failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (pace.leftToday <= 0) {
        log(`[email] SES daily quota reached; campaign ${c.id} continues when it frees up`);
        continue;
      }
      let leftToday = pace.leftToday;
      if (c.status === "scheduled") await pool.query(`UPDATE email_campaigns SET status = 'sending', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1::uuid`, [c.id]);
      const gap = Math.max(50, Math.floor(60_000 / pace.perMinute));
      while (Date.now() - started < TICK_BUDGET_MS) {
        if (leftToday <= 0) break;
        const st = await pool.query<{ status: string }>(`SELECT status FROM email_campaigns WHERE id = $1::uuid`, [c.id]);
        if (st.rows[0]?.status !== "sending") break;
        const next = await pool.query<{ id: string; contact_id: string; email: string; first_name: string | null; code: string | null; discount_gid: string | null }>(
          `UPDATE email_campaign_recipients SET status = 'sending'
            WHERE id = (SELECT id FROM email_campaign_recipients WHERE campaign_id = $1::uuid AND status = 'queued' ORDER BY sort_key, id LIMIT 1 FOR UPDATE SKIP LOCKED)
           RETURNING id::text, contact_id::text, email, first_name, code, discount_gid`,
          [c.id],
        );
        const r = next.rows[0];
        if (!r) {
          await pool.query(`UPDATE email_campaigns SET status = 'sent', finished_at = now(), updated_at = now() WHERE id = $1::uuid AND status = 'sending'
                              AND NOT EXISTS (SELECT 1 FROM email_campaign_recipients WHERE campaign_id = $1::uuid AND status IN ('queued','sending'))`, [c.id]);
          log(`[email] campaign ${c.id} finished`);
          break;
        }
        const t0 = Date.now();
        try {
          const ok = await pool.query<{ unsub_token: string }>(
            `SELECT unsub_token FROM email_contacts WHERE id = $1::bigint AND excluded_reason IS NULL AND unsubscribed_at IS NULL AND bounced_at IS NULL AND complained_at IS NULL`,
            [r.contact_id],
          );
          if (!ok.rows[0]) {
            await pool.query(`UPDATE email_campaign_recipients SET status = 'skipped', error = 'Unsubscribed or bounced before sending' WHERE id = $1::bigint`, [r.id]);
            continue;
          }
          let code = r.code;
          if (c.offer && !code) {
            let made: { code: string; gid: string };
            try {
              made = await createPersonalCode({ name: c.name, offer: c.offer });
            } catch (e) {
              // Never fail a person for a Shopify problem: put them back and retry (busy) or pause (anything else).
              const m = e instanceof Error ? e.message : String(e);
              await pool.query(`UPDATE email_campaign_recipients SET status = 'queued' WHERE id = $1::bigint`, [r.id]);
              if (/throttl|rate|too many|timeout|5\d\d|fetch failed/i.test(m)) {
                log(`[email] Shopify busy making codes (${m}); retrying next tick`);
              } else {
                await pool.query(`UPDATE email_campaigns SET status = 'paused', pause_reason = $2, updated_at = now() WHERE id = $1::uuid`, [c.id, `Shopify could not make the personal codes: ${m}`]);
              }
              break;
            }
            code = made.code;
            await pool.query(`UPDATE email_campaign_recipients SET code = $2, discount_gid = $3 WHERE id = $1::bigint`, [r.id, made.code, made.gid]);
          }
          const mail = renderFor({ subject: c.subject, html: c.html ?? "" }, mergeValuesFor({ firstName: r.first_name, code, offer: c.offer, unsubToken: ok.rows[0].unsub_token }));
          const rid = await sendOne(s, {
            to: r.email,
            ...mail,
            unsub: unsubscribeUrl(ok.rows[0].unsub_token),
            tags: [{ name: "campaign", value: c.id }],
          });
          leftToday--;
          await pool.query(`UPDATE email_campaign_recipients SET status = 'sent', message_id = $2, sent_at = now(), error = NULL WHERE id = $1::bigint`, [r.id, rid]);
          await pool.query(`UPDATE email_contacts SET last_emailed_at = now() WHERE id = $1::bigint`, [r.contact_id]);
          await pool.query(`UPDATE email_campaigns SET updated_at = now() WHERE id = $1::uuid`, [c.id]);
          sent++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const kind = e instanceof SesSendError ? e.kind : "other";
          if (kind === "throttle") {
            await pool.query(`UPDATE email_campaign_recipients SET status = 'queued' WHERE id = $1::bigint`, [r.id]);
            log(`[email] SES is throttling; waiting for the next tick`);
            break;
          }
          if (kind === "account") {
            await pool.query(`UPDATE email_campaign_recipients SET status = 'queued' WHERE id = $1::bigint`, [r.id]);
            await pool.query(`UPDATE email_campaigns SET status = 'paused', pause_reason = $2, updated_at = now() WHERE id = $1::uuid`, [c.id, `Amazon SES refused the send: ${msg}`]);
            break;
          }
          await pool.query(`UPDATE email_campaign_recipients SET status = 'failed', error = $2 WHERE id = $1::bigint`, [r.id, msg.slice(0, 500)]);
          failed++;
        }
        const stats = await campaignStats(pool, c.id);
        const why = shouldPause({ sent: stats.sent, bounced: stats.bounced, complained: stats.complained, pausePct: s.bouncePausePct });
        if (why) {
          await pool.query(`UPDATE email_campaigns SET status = 'paused', pause_reason = $2, updated_at = now() WHERE id = $1::uuid AND status = 'sending'`, [c.id, `Paused by itself: ${why}`]);
          log(`[email] campaign ${c.id} paused: ${why}`);
          break;
        }
        const wait = gap - (Date.now() - t0);
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      }
      if (Date.now() - started >= TICK_BUDGET_MS) break;
    }
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('carbon_email_send'))`).catch(() => {});
    lock.release();
  }
  return { sent, failed };
}

/* ------------------------------------------------------------------ results */

/** Read code use + sales back from Shopify for campaigns with codes (every 3 h). */
export async function refreshResults(pool: Pool, onlyId?: string): Promise<number> {
  const ctx = await welcomeShopCtx();
  if (!ctx) return 0;
  const camps = await pool.query<{ id: string }>(
    onlyId
      ? `SELECT id::text FROM email_campaigns WHERE id = $1::uuid`
      : `SELECT id::text FROM email_campaigns WHERE offer IS NOT NULL AND status IN ('sending','sent','paused','cancelled') AND started_at IS NOT NULL
           AND (results_at IS NULL OR results_at < now() - interval '3 hours') AND (offer->>'endsAt')::timestamptz > now() - interval '3 days' LIMIT 3`,
    onlyId ? [onlyId] : [],
  );
  let n = 0;
  for (const c of camps.rows) {
    // Stamp first: a Shopify error must not make the worker retry every minute.
    await pool.query(`UPDATE email_campaigns SET results_at = now() WHERE id = $1::uuid`, [c.id]);
    const rows = await pool.query<{ id: string; code: string; discount_gid: string }>(
      `SELECT id::text, code, discount_gid FROM email_campaign_recipients WHERE campaign_id = $1::uuid AND discount_gid IS NOT NULL AND used_at IS NULL`,
      [c.id],
    );
    for (let i = 0; i < rows.rows.length; i += 50) {
      const chunk = rows.rows.slice(i, i + 50);
      const d = await welcomeGql<{ nodes: ({ id: string; codeDiscount?: { asyncUsageCount?: number } } | null)[] }>(
        ctx,
        `query Use($ids: [ID!]!) { nodes(ids: $ids) { ... on DiscountCodeNode { id codeDiscount { ... on DiscountCodeBasic { asyncUsageCount } } } } }`,
        { ids: chunk.map((r) => r.discount_gid) },
      );
      for (const node of d.nodes) {
        if (!node || !(node.codeDiscount?.asyncUsageCount ?? 0)) continue;
        const r = chunk.find((x) => x.discount_gid === node.id);
        if (!r) continue;
        const o = await welcomeGql<{ orders: { nodes: { name: string; createdAt: string; currentTotalPriceSet: { shopMoney: { amount: string } } }[] } }>(
          ctx,
          `query Ord($q: String!) { orders(first: 1, query: $q, sortKey: CREATED_AT) { nodes { name createdAt currentTotalPriceSet { shopMoney { amount } } } } }`,
          { q: `discount_code:${r.code}` },
        ).catch(() => null);
        const ord = o?.orders.nodes[0];
        await pool.query(
          `UPDATE email_campaign_recipients SET used_at = COALESCE($2::timestamptz, now()), used_order = $3, used_total = $4 WHERE id = $1::bigint`,
          [r.id, ord?.createdAt ?? null, ord?.name ?? null, ord ? Number(ord.currentTotalPriceSet.shopMoney.amount) : null],
        );
      }
    }
    const stats = await campaignStats(pool, c.id);
    await pool.query(`UPDATE email_campaigns SET results = $2, results_at = now() WHERE id = $1::uuid`, [c.id, JSON.stringify({ used: stats.used, sales: stats.sales })]);
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ events */

/** An SES event (the "Message" of an SNS notification). */
export type SesEvent = {
  eventType: string;
  mail?: { messageId?: string; destination?: string[]; timestamp?: string };
  bounce?: { bounceType?: string; timestamp?: string };
  complaint?: { timestamp?: string };
  delivery?: { timestamp?: string };
  open?: { timestamp?: string };
  click?: { timestamp?: string; link?: string };
};

/** One SES event (SNS signature already checked). Idempotent by SNS message id. */
export async function applyEvent(pool: Pool, snsId: string, ev: SesEvent): Promise<void> {
  const mid = ev.mail?.messageId ?? null;
  const email = ev.mail?.destination?.[0]?.toLowerCase() ?? null;
  const type = String(ev.eventType ?? "").toLowerCase();
  const ins = await pool.query(`INSERT INTO email_events (id, type, message_id, email, payload) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [snsId, type, mid, email, JSON.stringify(ev)]);
  if (!ins.rowCount || !mid) return;
  const at =
    ev.delivery?.timestamp ?? ev.open?.timestamp ?? ev.click?.timestamp ?? ev.bounce?.timestamp ?? ev.complaint?.timestamp ?? new Date().toISOString();
  const col: Record<string, string> = { delivery: "delivered_at", open: "opened_at", click: "clicked_at", complaint: "complained_at" };
  if (type === "bounce" && ev.bounce?.bounceType === "Permanent") col.bounce = "bounced_at";
  const c = col[type];
  if (c) await pool.query(`UPDATE email_campaign_recipients SET ${c} = COALESCE(${c}, $2::timestamptz) WHERE message_id = $1`, [mid, at]);
  // A click proves the email was opened even when the picture-pixel was blocked.
  if (type === "click") await pool.query(`UPDATE email_campaign_recipients SET opened_at = COALESCE(opened_at, $2::timestamptz) WHERE message_id = $1`, [mid, at]);
  if (type === "bounce" && ev.bounce?.bounceType === "Permanent") {
    await pool.query(`UPDATE email_contacts SET bounced_at = COALESCE(bounced_at, $2::timestamptz) WHERE id = (SELECT contact_id FROM email_campaign_recipients WHERE message_id = $1 LIMIT 1)`, [mid, at]);
  }
  if (type === "complaint") {
    const r = await pool.query<{ shopify_customer_gid: string | null }>(
      `UPDATE email_contacts SET complained_at = COALESCE(complained_at, $2::timestamptz), unsubscribed_at = COALESCE(unsubscribed_at, $2::timestamptz),
              unsubscribe_source = COALESCE(unsubscribe_source, 'complaint')
        WHERE id = (SELECT contact_id FROM email_campaign_recipients WHERE message_id = $1 LIMIT 1) RETURNING shopify_customer_gid`,
      [mid, at],
    );
    await markShopifyUnsubscribed(r.rows[0]?.shopify_customer_gid ?? null);
  }
}
