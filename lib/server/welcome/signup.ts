/**
 * Email Popup — what POST /api/storefront/welcome-signup runs.
 *
 *  1. Screens out bots (honeypot field, too-quick submit, automation user
 *     agents, server-farm and crawler IPs — Carbon Shield's IP data), and
 *     addresses whose domain cannot receive mail.
 *  2. One row per email, ever. A repeat signup gets its existing code emailed
 *     again (never shown on screen, so typing someone else's email reveals
 *     nothing) and never a second code.
 *  3. Limits: 3 signups per IP per 24 h, 100 per hour for the whole store.
 *  4. Shopify: finds or creates the customer, subscribes them to email
 *     marketing (single opt-in, tagged "welcome-popup"), and creates ONE code:
 *     WELCOME{percent}-XXXXXX, single use, locked to that customer, products
 *     in the hidden full-price collection only, combines with nothing (so never
 *     a double discount; Shopify then gives the shopper whichever discount saves
 *     more), never on shipping.
 *  5. The email with the code goes out after the answer (deliverWelcomeEmail).
 */
import { randomBytes } from "node:crypto";
import { promises as dns } from "node:dns";
import type { Pool } from "pg";
import { getIpDb, ipv4ToInt, lookupIp } from "@/lib/server/shield/ipdb";
import { datacenterLabel, isAutomationUa } from "@/lib/server/shield/networks";
import {
  MAX_SIGNUPS_PER_HOUR,
  MAX_SIGNUPS_PER_IP_PER_DAY,
  WELCOME_TAG,
  emailDomain,
  formOf,
  normalizeEmail,
  screenRequest,
  welcomeCode,
} from "./rules";
import { fullPriceCollectionId, getWelcomeSettings, userErrorText, welcomeGql, welcomeShopCtx } from "./config";
import { sendWelcomeEmail } from "./email";

export type SignupInput = {
  email: unknown;
  honeypot: unknown;
  openMs: unknown;
  path: unknown;
  locale: unknown;
  /** "popup" or "footer" (the footer newsletter uses the same signup). */
  form: unknown;
  ip: string | null;
  ua: string;
};

export type SignupAnswer =
  | { ok: true; status: "created"; email: string; code: string; percent: number; endsAt: string; emailing: boolean; id: number }
  | { ok: true; status: "existing"; email: string; emailing: boolean; id: number; code?: string; endsAt?: string }
  | { ok: true; status: "used"; email: string }
  | { ok: true; status: "expired"; email: string; endsAt: string }
  | { ok: false; error: "invalid_email" | "too_many" | "busy" | "try_again" | "server" };

const SHOP_LOCALES = new Set(["en", "es", "pt-BR"]);
/** A repeat signup re-sends the email at most this often. */
const RESEND_EVERY_MS = 10 * 60_000;

// Domains that can receive mail, remembered for 6 h (most signups are gmail.com, icloud.com, …).
const mxCache = new Map<string, { ok: boolean; at: number }>();
const MX_TTL_MS = 6 * 3600_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => (timer = setTimeout(() => rej(new Error("timeout")), ms)))]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** false only when DNS says the domain has no mail server (or does not exist). */
async function domainTakesMail(domain: string): Promise<boolean> {
  const hit = mxCache.get(domain);
  if (hit && Date.now() - hit.at < MX_TTL_MS) return hit.ok;
  let ok = true;
  try {
    const mx = await withTimeout(dns.resolveMx(domain), 3000);
    ok = mx.some((r) => r.exchange && r.exchange !== ".");
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      // No MX record: mail falls back to the domain's own address (RFC 5321).
      ok = await withTimeout(dns.resolve4(domain), 3000).then((a) => a.length > 0, () => false);
    }
    // Timeouts and resolver trouble: give the shopper the benefit of the doubt.
  }
  mxCache.set(domain, { ok, at: Date.now() });
  return ok;
}

type Row = {
  id: number;
  code: string;
  ends_at: Date;
  used_at: Date | null;
  unsubscribed_at: Date | null;
  emailed_at: Date | null;
  resent_at: Date | null;
  shopify_customer_gid: string | null;
};

const SUBSCRIBE = () => ({
  marketingState: "SUBSCRIBED",
  marketingOptInLevel: "SINGLE_OPT_IN",
  consentUpdatedAt: new Date().toISOString(),
});

type Ctx = NonNullable<Awaited<ReturnType<typeof welcomeShopCtx>>>;

async function findCustomer(ctx: Ctx, email: string) {
  const d = await welcomeGql<{
    customerByIdentifier: { id: string; defaultEmailAddress: { marketingState: string } | null } | null;
  }>(
    ctx,
    `query WelcomeCustomer($e: String!) {
      customerByIdentifier(identifier: { emailAddress: $e }) { id defaultEmailAddress { marketingState } }
    }`,
    { e: email },
  );
  return d.customerByIdentifier;
}

/** Subscribed Shopify customer for this email: { id, existed }. */
async function ensureSubscribedCustomer(ctx: Ctx, email: string, locale: string | null): Promise<{ id: string; existed: boolean }> {
  let found = await findCustomer(ctx, email);
  if (!found) {
    const made = await welcomeGql<{
      customerCreate: { customer: { id: string } | null; userErrors: { field: string[] | null; message: string }[] };
    }>(
      ctx,
      `mutation WelcomeCustomerCreate($i: CustomerInput!) {
        customerCreate(input: $i) { customer { id } userErrors { field message } }
      }`,
      { i: { email, emailMarketingConsent: SUBSCRIBE(), tags: [WELCOME_TAG], ...(locale ? { locale } : {}) } },
    );
    if (made.customerCreate.customer) return { id: made.customerCreate.customer.id, existed: false };
    // "Email has already been taken": created a moment ago elsewhere — use that one.
    found = await findCustomer(ctx, email);
    if (!found) throw new Error(userErrorText(made.customerCreate.userErrors) || "Could not create the customer");
  }
  /* An existing customer who types their email into the popup is opting in now.
     A consent or tag hiccup must not cost the shopper their code: logged only. */
  if (found.defaultEmailAddress?.marketingState !== "SUBSCRIBED") {
    await welcomeGql<{ customerEmailMarketingConsentUpdate: { userErrors: { message: string }[] } }>(
      ctx,
      `mutation WelcomeConsent($i: CustomerEmailMarketingConsentUpdateInput!) {
        customerEmailMarketingConsentUpdate(input: $i) { userErrors { message } }
      }`,
      { i: { customerId: found.id, emailMarketingConsent: SUBSCRIBE() } },
    )
      .then((r) => {
        const errs = userErrorText(r.customerEmailMarketingConsentUpdate.userErrors);
        if (errs) console.warn("[welcome] consent", found!.id, errs);
      })
      .catch((e) => console.warn("[welcome] consent", found!.id, e instanceof Error ? e.message : e));
  }
  await welcomeGql<{ tagsAdd: { userErrors: { message: string }[] } }>(
    ctx,
    `mutation WelcomeTag($id: ID!, $t: [String!]!) { tagsAdd(id: $id, tags: $t) { userErrors { message } } }`,
    { id: found.id, t: [WELCOME_TAG] },
  ).catch((e) => console.warn("[welcome] tag", found!.id, e instanceof Error ? e.message : e));
  return { id: found.id, existed: true };
}

async function createCode(ctx: Ctx, customerId: string, percent: number, endsAt: Date): Promise<{ code: string; gid: string }> {
  const collection = await fullPriceCollectionId(ctx);
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = welcomeCode(percent);
    const r = await welcomeGql<{
      discountCodeBasicCreate: { codeDiscountNode: { id: string } | null; userErrors: { message: string }[] };
    }>(
      ctx,
      `mutation WelcomeCode($d: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $d) { codeDiscountNode { id } userErrors { field message code } }
      }`,
      {
        d: {
          title: `Email popup ${percent}% — ${code}`,
          code,
          startsAt: new Date().toISOString(),
          endsAt: endsAt.toISOString(),
          context: { customers: { add: [customerId] } },
          customerGets: { value: { percentage: percent / 100 }, items: { collections: { add: [collection] } } },
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
    if (!errs.some((e) => /unique|taken|already/i.test(e.message))) break; // only a clash is worth a new code
  }
  throw new Error(lastError);
}

async function deleteCode(ctx: Ctx, gid: string): Promise<void> {
  await welcomeGql(ctx, `mutation($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId } }`, { id: gid }).catch(
    (e) => console.error("[welcome] could not delete orphan code", gid, e),
  );
}

/** A repeat signup: same code, emailed again (at most every 10 min). */
async function answerExisting(pool: Pool, row: Row, email: string, sendEmail: boolean): Promise<SignupAnswer> {
  if (row.used_at) return { ok: true, status: "used", email };
  if (row.ends_at.getTime() <= Date.now()) return { ok: true, status: "expired", email, endsAt: row.ends_at.toISOString() };
  if (row.unsubscribed_at) {
    // Signing up again after unsubscribing is a new opt-in.
    const ctx = await welcomeShopCtx();
    if (ctx && row.shopify_customer_gid) {
      await welcomeGql(
        ctx,
        `mutation($i: CustomerEmailMarketingConsentUpdateInput!) { customerEmailMarketingConsentUpdate(input: $i) { userErrors { message } } }`,
        { i: { customerId: row.shopify_customer_gid, emailMarketingConsent: SUBSCRIBE() } },
      ).catch((e) => console.warn("[welcome] re-subscribe", e instanceof Error ? e.message : e));
    }
    await pool.query(`UPDATE welcome_signups SET unsubscribed_at = NULL WHERE id = $1`, [row.id]);
  }
  if (!sendEmail) {
    return { ok: true, status: "existing", email, emailing: false, id: row.id, code: row.code, endsAt: row.ends_at.toISOString() };
  }
  const last = Math.max(row.emailed_at?.getTime() ?? 0, row.resent_at?.getTime() ?? 0);
  return { ok: true, status: "existing", email, emailing: Date.now() - last > RESEND_EVERY_MS, id: row.id };
}

export async function runWelcomeSignup(pool: Pool, input: SignupInput): Promise<SignupAnswer> {
  const bot = screenRequest({ honeypot: input.honeypot, openMs: input.openMs, ua: input.ua }) ?? (isAutomationUa(input.ua) ? "automation" : null);
  const db = await getIpDb(pool).catch(() => null);
  const info = lookupIp(db, ipv4ToInt(input.ip));
  const farm = info.goodBot ? `crawler ${info.goodBot}` : (info.cloud ?? datacenterLabel(info.asn, info.org));
  if (bot || farm) {
    console.info("[welcome] turned away:", bot ?? farm, input.ip);
    return { ok: false, error: "try_again" };
  }

  const email = normalizeEmail(input.email);
  if (!email || !(await domainTakesMail(emailDomain(email)))) return { ok: false, error: "invalid_email" };

  const settings = await getWelcomeSettings(pool);
  const existing = await pool.query<Row>(`SELECT * FROM welcome_signups WHERE email = $1`, [email]);
  if (existing.rows[0]) return answerExisting(pool, existing.rows[0], email, settings.sendEmail);

  const limits = await pool.query<{ ip_day: string; hour: string }>(
    `SELECT count(*) FILTER (WHERE ip = $1 AND created_at > now() - interval '24 hours') AS ip_day,
            count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS hour
       FROM welcome_signups WHERE created_at > now() - interval '24 hours'`,
    [input.ip ?? ""],
  );
  if (input.ip && Number(limits.rows[0]?.ip_day ?? 0) >= MAX_SIGNUPS_PER_IP_PER_DAY) return { ok: false, error: "too_many" };
  if (Number(limits.rows[0]?.hour ?? 0) >= MAX_SIGNUPS_PER_HOUR) return { ok: false, error: "busy" };

  const ctx = await welcomeShopCtx();
  if (!ctx) return { ok: false, error: "server" };
  const locale = typeof input.locale === "string" && SHOP_LOCALES.has(input.locale) ? input.locale : null;
  const path = typeof input.path === "string" ? input.path.slice(0, 300) : null;

  // One signup per email at a time: a double tap must not create two codes.
  const client = await pool.connect();
  let made: { code: string; gid: string } | null = null;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('welcome:' || $1))", [email]);
    const again = await client.query<Row>(`SELECT * FROM welcome_signups WHERE email = $1`, [email]);
    if (again.rows[0]) {
      await client.query("COMMIT");
      return answerExisting(pool, again.rows[0], email, settings.sendEmail);
    }
    const customer = await ensureSubscribedCustomer(ctx, email, locale);
    const percent = settings.percentOff;
    const endsAt = new Date(Date.now() + settings.validDays * 86_400_000);
    made = await createCode(ctx, customer.id, percent, endsAt);
    const ins = await client.query<{ id: number }>(
      `INSERT INTO welcome_signups
         (email, shopify_customer_gid, existing_customer, code, discount_gid, percent_off, ends_at,
          locale, source_path, ip, country, asn, unsub_token, form)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        email,
        customer.id,
        customer.existed,
        made.code,
        made.gid,
        percent,
        endsAt,
        locale,
        path,
        input.ip,
        info.country,
        info.asn,
        randomBytes(24).toString("base64url"),
        formOf(input.form),
      ],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      status: "created",
      email,
      code: made.code,
      percent,
      endsAt: endsAt.toISOString(),
      emailing: settings.sendEmail,
      id: ins.rows[0].id,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (made) await deleteCode(ctx, made.gid); // never leave a code nobody has a record of
    console.error("[welcome] signup failed", email, e);
    return { ok: false, error: "server" };
  } finally {
    client.release();
  }
}

/** Send (or re-send) the code email for one signup. Never throws. */
export async function deliverWelcomeEmail(pool: Pool, id: number, kind: "first" | "resend"): Promise<void> {
  try {
    const r = await pool.query<{
      email: string;
      code: string;
      percent_off: number;
      ends_at: Date;
      locale: string | null;
      unsub_token: string;
    }>(`SELECT email, code, percent_off, ends_at, locale, unsub_token FROM welcome_signups WHERE id = $1`, [id]);
    const row = r.rows[0];
    if (!row) return;
    await sendWelcomeEmail({
      to: row.email,
      code: row.code,
      percent: row.percent_off,
      endsAt: row.ends_at,
      locale: row.locale,
      unsubToken: row.unsub_token,
    });
    await pool.query(
      kind === "first"
        ? `UPDATE welcome_signups SET emailed_at = now(), email_error = NULL WHERE id = $1`
        : `UPDATE welcome_signups SET resent_at = now(), email_error = NULL WHERE id = $1`,
      [id],
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[welcome] email", id, msg);
    await pool.query(`UPDATE welcome_signups SET email_error = $2 WHERE id = $1`, [id, msg.slice(0, 500)]).catch(() => {});
  }
}

/** orders/paid: a welcome code used on this order. Idempotent. */
export async function markWelcomeCodesUsed(
  pool: Pool,
  codes: string[],
  orderName: string | null,
  total: number | null,
): Promise<void> {
  if (!codes.length) return;
  await pool.query(
    `UPDATE welcome_signups
        SET used_at = now(), used_order_name = $2, used_order_total = $3
      WHERE upper(code) = ANY($1::text[]) AND used_at IS NULL`,
    [codes.map((c) => c.toUpperCase()), orderName, total],
  );
}

/** The unsubscribe link in the email: stop marketing email for that address. */
export async function unsubscribeWelcome(pool: Pool, token: string): Promise<{ ok: boolean; email?: string }> {
  const r = await pool.query<{ id: number; email: string; shopify_customer_gid: string | null }>(
    `SELECT id, email, shopify_customer_gid FROM welcome_signups WHERE unsub_token = $1`,
    [token],
  );
  const row = r.rows[0];
  if (!row) return { ok: false };
  const ctx = await welcomeShopCtx();
  if (!ctx || !row.shopify_customer_gid) return { ok: false, email: row.email };
  const res = await welcomeGql<{ customerEmailMarketingConsentUpdate: { userErrors: { message: string }[] } }>(
    ctx,
    `mutation WelcomeUnsubscribe($i: CustomerEmailMarketingConsentUpdateInput!) {
      customerEmailMarketingConsentUpdate(input: $i) { userErrors { message } }
    }`,
    {
      i: {
        customerId: row.shopify_customer_gid,
        emailMarketingConsent: { marketingState: "UNSUBSCRIBED", consentUpdatedAt: new Date().toISOString() },
      },
    },
  );
  const errs = userErrorText(res.customerEmailMarketingConsentUpdate.userErrors);
  if (errs) {
    console.error("[welcome] unsubscribe", row.id, errs);
    return { ok: false, email: row.email };
  }
  await pool.query(`UPDATE welcome_signups SET unsubscribed_at = COALESCE(unsubscribed_at, now()) WHERE id = $1`, [row.id]);
  return { ok: true, email: row.email };
}
