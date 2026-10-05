/**
 * Thank-you code: printing an order's packing slip creates ONE Shopify
 * discount code for that order — 15% off the customer's next order.
 *
 *  - Unique random code (CARBON15-XXXXXX), single use, locked to the order's
 *    customer, combinable with other discounts, every product (sale included).
 *  - Valid from now until 45 days after the PURCHASE date.
 *  - One per order: a reprint finds the saved row and creates nothing.
 *  - No code when the order has no customer, is cancelled, or is already past
 *    its 45 days.
 *  - Not printed on the slip. Carbon Rewards (rewards.shopcarbon.com) shows it,
 *    copyable, on the customer's Rewards page in their Shopify account.
 *  - Cancelling the order (any reason) expires the code at once — see
 *    expireThankYouCodeForOrder and the orders/cancelled webhook.
 *  - The order panel's "Thank-you code" switch (default ON) controls it per
 *    order: OFF = printing creates nothing and an existing code for THIS order
 *    is deleted; ON = the code is created at once. See setThankYouEnabled.
 *
 * Never throws: a failure here is logged and the slip still prints.
 */
import { randomInt } from "node:crypto";
import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";

export const THANK_YOU_PERCENT = 15;
export const THANK_YOU_VALID_DAYS = 45;
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I

export type ThankYouCodeResult =
  | { status: "created" | "existing"; code: string; endsAt: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

function randomCode(): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `CARBON${THANK_YOU_PERCENT}-${s}`;
}

export async function ensureThankYouCode(
  pool: Pool,
  orderLegacyId: string,
  opts: { tenantId: string; userId: string | null },
): Promise<ThankYouCodeResult> {
  try {
    const existing = await pool.query<{ code: string; ends_at: Date }>(
      `SELECT code, ends_at FROM order_thank_you_codes WHERE shopify_order_id = $1`,
      [orderLegacyId],
    );
    if (existing.rows[0]) {
      return { status: "existing", code: existing.rows[0].code, endsAt: existing.rows[0].ends_at.toISOString() };
    }

    const off = await pool.query(`SELECT 1 FROM order_thank_you_optout WHERE shopify_order_id = $1`, [orderLegacyId]);
    if (off.rowCount) return { status: "skipped", reason: "thank-you code is switched off for this order" };

    const ctx = await resolveShopContext();
    if (!ctx) return { status: "failed", reason: "Shopify is not connected" };

    const o = await runShopifyGraphql<{
      order: { name: string; createdAt: string; cancelledAt: string | null; customer: { id: string } | null } | null;
    }>({
      ...ctx,
      query: `query ThankYouOrder($id: ID!) { order(id: $id) { name createdAt cancelledAt customer { id } } }`,
      variables: { id: `gid://shopify/Order/${orderLegacyId}` },
    });
    const order = o.ok ? o.data?.order : null;
    if (!order) return { status: "failed", reason: "order not found" };
    if (order.cancelledAt) return { status: "skipped", reason: "order is cancelled" };
    if (!order.customer) return { status: "skipped", reason: "order has no customer" };
    const endsAt = new Date(Date.parse(order.createdAt) + THANK_YOU_VALID_DAYS * 86_400_000);
    if (endsAt.getTime() <= Date.now()) return { status: "skipped", reason: `order is older than ${THANK_YOU_VALID_DAYS} days` };

    // Serialise per order so two prints at the same moment create one code.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('thank-you:' || $1))", [orderLegacyId]);
      const again = await client.query<{ code: string; ends_at: Date }>(
        `SELECT code, ends_at FROM order_thank_you_codes WHERE shopify_order_id = $1`,
        [orderLegacyId],
      );
      if (again.rows[0]) {
        await client.query("COMMIT");
        return { status: "existing", code: again.rows[0].code, endsAt: again.rows[0].ends_at.toISOString() };
      }

      let created: { code: string; gid: string } | null = null;
      let lastError = "";
      for (let attempt = 0; attempt < 4 && !created; attempt++) {
        const code = randomCode();
        const r = await runShopifyGraphql<{
          discountCodeBasicCreate: {
            codeDiscountNode: { id: string } | null;
            userErrors: { field: string[] | null; message: string; code: string | null }[];
          };
        }>({
          ...ctx,
          query: `mutation ThankYouCode($d: DiscountCodeBasicInput!) {
            discountCodeBasicCreate(basicCodeDiscount: $d) {
              codeDiscountNode { id }
              userErrors { field message code }
            }
          }`,
          variables: {
            d: {
              title: `Thank you ${order.name} — ${THANK_YOU_PERCENT}% off next order`,
              code,
              startsAt: new Date().toISOString(),
              endsAt: endsAt.toISOString(),
              context: { customers: { add: [order.customer.id] } },
              customerGets: { value: { percentage: THANK_YOU_PERCENT / 100 }, items: { all: true } },
              appliesOncePerCustomer: true,
              usageLimit: 1,
              combinesWith: { orderDiscounts: true, productDiscounts: true, shippingDiscounts: true },
            },
          },
        });
        const res = r.ok ? r.data?.discountCodeBasicCreate : null;
        if (res?.codeDiscountNode?.id) {
          created = { code, gid: res.codeDiscountNode.id };
          break;
        }
        const errs = res?.userErrors ?? [];
        lastError = errs.map((e) => e.message).join("; ") || "Shopify returned an error";
        // Only a code clash is worth another try with a new code.
        if (!errs.some((e) => /unique|taken|already/i.test(e.message))) break;
      }
      if (!created) {
        await client.query("ROLLBACK");
        return { status: "failed", reason: lastError };
      }

      await client.query(
        `INSERT INTO order_thank_you_codes
           (shopify_order_id, order_name, shopify_customer_gid, code, discount_gid, percent_off, ends_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderLegacyId, order.name, order.customer.id, created.code, created.gid, THANK_YOU_PERCENT, endsAt, opts.userId],
      );
      await client.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
         SELECT $1::uuid, u.id, 'thank_you_code_created', $2, $3::jsonb
         FROM (SELECT 1) one LEFT JOIN users u ON u.id = $4::uuid`,
        [
          opts.tenantId,
          `order:${orderLegacyId}`,
          JSON.stringify({
            summary: `${created.code} · ${THANK_YOU_PERCENT}% off · order ${order.name} · until ${endsAt.toISOString().slice(0, 10)}`,
            order: order.name,
            code: created.code,
            customer: order.customer.id,
            ends_at: endsAt.toISOString(),
          }),
          opts.userId,
        ],
      );
      await client.query("COMMIT");
      return { status: "created", code: created.code, endsAt: endsAt.toISOString() };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    console.error("[thank-you-code]", orderLegacyId, e);
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Expire an order's thank-you code NOW — called when the order is cancelled,
 * for any reason. Shopify's discountCodeDeactivate sets the code's end date to
 * now (status EXPIRED, unusable at checkout); the row's ends_at moves too, so
 * Carbon Rewards stops showing it. Safe to call twice; a no-op when the order
 * has no code.
 */
export async function expireThankYouCodeForOrder(
  pool: Pool,
  orderLegacyId: string,
  reason: string,
): Promise<{ status: "expired" | "none" | "already" | "failed"; code?: string; error?: string }> {
  const r = await pool.query<{ code: string; discount_gid: string; expired_at: Date | null; used_at: Date | null }>(
    `SELECT code, discount_gid, expired_at, used_at FROM order_thank_you_codes WHERE shopify_order_id = $1`,
    [orderLegacyId],
  );
  const row = r.rows[0];
  if (!row) return { status: "none" };
  if (row.expired_at) return { status: "already", code: row.code };

  const ctx = await resolveShopContext();
  if (!ctx) return { status: "failed", code: row.code, error: "Shopify is not connected" };
  const res = await runShopifyGraphql<{
    discountCodeDeactivate: { codeDiscountNode: { id: string } | null; userErrors: { message: string }[] };
  }>({
    ...ctx,
    query: `mutation ExpireThankYou($id: ID!) {
      discountCodeDeactivate(id: $id) { codeDiscountNode { id } userErrors { message } }
    }`,
    variables: { id: row.discount_gid },
  });
  const errs = res.ok ? (res.data?.discountCodeDeactivate.userErrors ?? []) : [{ message: "Shopify returned an error" }];
  // A code already deleted in Shopify admin cannot be used either — still expire the row.
  const gone = errs.some((e) => /not exist|not found/i.test(e.message));
  if (errs.length && !gone) return { status: "failed", code: row.code, error: errs.map((e) => e.message).join("; ") };

  await pool.query(
    `UPDATE order_thank_you_codes
        SET ends_at = LEAST(ends_at, now()), expired_at = now(), expired_reason = $2
      WHERE shopify_order_id = $1 AND expired_at IS NULL`,
    [orderLegacyId, reason],
  );
  return { status: "expired", code: row.code };
}

export type ThankYouState = {
  /** Switch position: false only when switched off for this order. */
  enabled: boolean;
  /** Why a code cannot exist (switch greyed out), or null when it can. */
  blocked: string | null;
  code: string | null;
  endsAt: string | null;
  used: boolean;
  expired: boolean;
};

async function orderBasics(orderLegacyId: string) {
  const ctx = await resolveShopContext();
  if (!ctx) return null;
  const o = await runShopifyGraphql<{
    order: { name: string; createdAt: string; cancelledAt: string | null; customer: { id: string } | null } | null;
  }>({
    ...ctx,
    query: `query ThankYouOrder($id: ID!) { order(id: $id) { name createdAt cancelledAt customer { id } } }`,
    variables: { id: `gid://shopify/Order/${orderLegacyId}` },
  });
  return o.ok ? (o.data?.order ?? null) : null;
}

/** What the order panel's switch shows for one order. */
export async function getThankYouState(pool: Pool, orderLegacyId: string): Promise<ThankYouState> {
  const [row, off, order] = await Promise.all([
    pool.query<{ code: string; ends_at: Date; used_at: Date | null; expired_at: Date | null }>(
      `SELECT code, ends_at, used_at, expired_at FROM order_thank_you_codes WHERE shopify_order_id = $1`,
      [orderLegacyId],
    ),
    pool.query(`SELECT 1 FROM order_thank_you_optout WHERE shopify_order_id = $1`, [orderLegacyId]),
    orderBasics(orderLegacyId),
  ]);
  const r = row.rows[0];
  const used = !!r?.used_at;
  const expired = !!r && !used && (!!r.expired_at || r.ends_at.getTime() <= Date.now());
  let blocked: string | null = null;
  if (used) blocked = "The customer already used this code";
  else if (expired) blocked = "This code has expired";
  else if (!order) blocked = "Could not read the order from Shopify";
  else if (order.cancelledAt) blocked = "Order is cancelled";
  else if (!order.customer) blocked = "Order has no customer account";
  else if (!r && Date.parse(order.createdAt) + THANK_YOU_VALID_DAYS * 86_400_000 <= Date.now()) {
    blocked = `Order is older than ${THANK_YOU_VALID_DAYS} days`;
  }
  return {
    enabled: (off.rowCount ?? 0) === 0,
    blocked,
    code: r?.code ?? null,
    endsAt: r ? r.ends_at.toISOString() : null,
    used,
    expired,
  };
}

/**
 * Flip the order's switch.
 *  ON  → clears the opt-out and creates the code now (ensureThankYouCode).
 *  OFF → records the opt-out and DELETES this order's code from Shopify and
 *        from Carbon Rewards. Only this order's code; a used code is left alone.
 */
export async function setThankYouEnabled(
  pool: Pool,
  orderLegacyId: string,
  on: boolean,
  opts: { tenantId: string; userId: string | null },
): Promise<{ ok: boolean; error?: string; state: ThankYouState }> {
  if (on) {
    await pool.query(`DELETE FROM order_thank_you_optout WHERE shopify_order_id = $1`, [orderLegacyId]);
    const r = await ensureThankYouCode(pool, orderLegacyId, opts);
    const state = await getThankYouState(pool, orderLegacyId);
    if (r.status === "failed") return { ok: false, error: r.reason, state };
    return { ok: true, state };
  }

  const row = await pool.query<{ code: string; discount_gid: string; order_name: string; used_at: Date | null }>(
    `SELECT code, discount_gid, order_name, used_at FROM order_thank_you_codes WHERE shopify_order_id = $1`,
    [orderLegacyId],
  );
  const existing = row.rows[0];
  if (existing?.used_at) {
    return { ok: false, error: "The customer already used this code", state: await getThankYouState(pool, orderLegacyId) };
  }
  if (existing) {
    const ctx = await resolveShopContext();
    if (!ctx) return { ok: false, error: "Shopify is not connected", state: await getThankYouState(pool, orderLegacyId) };
    const d = await runShopifyGraphql<{
      discountCodeDelete: { deletedCodeDiscountId: string | null; userErrors: { message: string }[] };
    }>({
      ...ctx,
      query: `mutation DeleteThankYou($id: ID!) { discountCodeDelete(id: $id) { deletedCodeDiscountId userErrors { message } } }`,
      variables: { id: existing.discount_gid },
    });
    const errs = d.ok ? (d.data?.discountCodeDelete.userErrors ?? []) : [{ message: "Shopify returned an error" }];
    // Already deleted in Shopify admin is fine — the code is gone either way.
    if (errs.length && !errs.some((e) => /not exist|not found/i.test(e.message))) {
      return { ok: false, error: errs.map((e) => e.message).join("; "), state: await getThankYouState(pool, orderLegacyId) };
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO order_thank_you_optout (shopify_order_id, order_name, opted_out_by)
       VALUES ($1, $2, $3) ON CONFLICT (shopify_order_id) DO NOTHING`,
      [orderLegacyId, existing?.order_name ?? null, opts.userId],
    );
    if (existing) {
      await client.query(`DELETE FROM order_thank_you_codes WHERE shopify_order_id = $1`, [orderLegacyId]);
      await client.query(
        `INSERT INTO audit_log (tenant_id, user_id, action, entity, metadata)
         SELECT $1::uuid, u.id, 'thank_you_code_deleted', $2, $3::jsonb
         FROM (SELECT 1) one LEFT JOIN users u ON u.id = $4::uuid`,
        [
          opts.tenantId,
          `order:${orderLegacyId}`,
          JSON.stringify({ summary: `${existing.code} · order ${existing.order_name}`, code: existing.code, order: existing.order_name }),
          opts.userId,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, state: await getThankYouState(pool, orderLegacyId) };
}
