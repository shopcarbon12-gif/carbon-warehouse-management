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
