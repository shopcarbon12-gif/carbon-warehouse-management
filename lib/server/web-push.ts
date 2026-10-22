/**
 * Phone/computer alerts (owner 2026-10-19): a push notification for every
 * Shopify order and every Studio night-batch result.
 *
 * Standard Web Push (VAPID). The key pair lives in `web_push_config` (one row,
 * generated on first use), so nothing has to be set in Coolify. Devices sign up
 * through /api/push ("Turn on alerts"); public/sw.js shows the notification and
 * tells any open WMS page to play the matching sound.
 *
 * Every function here swallows its own errors: an alert must never fail a
 * Shopify webhook or a batch save.
 */
import webpush from "web-push";
import type { Pool } from "pg";

export type PushKind = "orders" | "studio" | "visitor_new" | "visitor_back" | "visitor_checkout" | "visitor_cart" | "test";
export type PushPayload = { kind: PushKind; title: string; body: string; url?: string; tag?: string; /** Which sound an open WMS page plays. */ sound?: PushSound };
/** Which sound an open WMS page plays: order ka-ching, Studio chime, visitor doorbell, checkout double doorbell. */
export type PushSound = "orders" | "studio" | "visitor" | "checkout";

const SUBJECT = "mailto:shopcarbon12@gmail.com";

let cached: { publicKey: string; privateKey: string } | null = null;

/** The VAPID key pair — created once, then read from the database. */
export async function getVapidKeys(pool: Pool): Promise<{ publicKey: string; privateKey: string }> {
  if (cached) return cached;
  const read = async () =>
    (await pool.query<{ public_key: string; private_key: string }>(`SELECT public_key, private_key FROM web_push_config WHERE id = 1`)).rows[0];
  let row = await read();
  if (!row) {
    const k = webpush.generateVAPIDKeys();
    /* Two web instances starting at once: the first insert wins, both read it back. */
    await pool.query(`INSERT INTO web_push_config (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`, [k.publicKey, k.privateKey]);
    row = await read();
  }
  cached = { publicKey: row.public_key, privateKey: row.private_key };
  return cached;
}

type SubRow = { id: string; endpoint: string; p256dh: string; auth: string };

/**
 * Send one alert to every subscription that wants this kind (optionally only
 * one user's devices). Gone subscriptions (404/410) are deleted. Returns how
 * many devices accepted it.
 */
export async function sendPush(
  pool: Pool,
  payload: PushPayload,
  opts: { tenantId?: string | null; userId?: string | null } = {},
): Promise<{ sent: number; failed: number }> {
  try {
    const keys = await getVapidKeys(pool);
    const where: string[] = [];
    const params: unknown[] = [];
    if (payload.kind !== "test") {
      params.push(payload.kind);
      where.push(`$${params.length} = ANY(kinds)`);
    }
    if (opts.userId) {
      params.push(opts.userId);
      where.push(`user_id = $${params.length}::uuid`);
    }
    if (opts.tenantId) {
      params.push(opts.tenantId);
      where.push(`(tenant_id IS NULL OR tenant_id = $${params.length}::uuid)`);
    }
    const subs = (
      await pool.query<SubRow>(
        `SELECT id::text, endpoint, p256dh, auth FROM web_push_subscriptions${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`,
        params,
      )
    ).rows;
    let sent = 0;
    let failed = 0;
    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
            vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
            TTL: 60 * 60 * 24,
            urgency: "high",
            topic: payload.tag ? payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined : undefined,
          });
          sent++;
          await pool.query(`UPDATE web_push_subscriptions SET last_ok_at = now(), last_error = NULL WHERE id = $1::uuid`, [s.id]);
        } catch (e) {
          failed++;
          const code = (e as { statusCode?: number })?.statusCode;
          if (code === 404 || code === 410) {
            await pool.query(`DELETE FROM web_push_subscriptions WHERE id = $1::uuid`, [s.id]);
          } else {
            const msg = e instanceof Error ? e.message : String(e);
            await pool.query(`UPDATE web_push_subscriptions SET last_error = $2 WHERE id = $1::uuid`, [s.id, msg.slice(0, 500)]);
          }
        }
      }),
    );
    if (subs.length) console.log(`[web-push] ${payload.kind}: sent ${sent}, failed ${failed} — ${payload.title}`);
    return { sent, failed };
  } catch (e) {
    console.warn("[web-push] send skipped:", e instanceof Error ? e.message : e);
    return { sent: 0, failed: 0 };
  }
}

function money(amount: unknown, currency: unknown): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: String(currency || "USD") }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

/** "New order #1234 · $95.00 · 2 items" — from the orders/paid webhook body. */
export async function notifyShopifyOrder(
  pool: Pool,
  order: { id?: number | string; name?: string; total_price?: string | number; currency?: string; line_items?: { quantity?: number | null; title?: string | null }[] },
): Promise<void> {
  const items = (order.line_items ?? []).reduce((a, li) => a + (Number(li?.quantity) || 0), 0);
  const first = order.line_items?.[0]?.title?.trim();
  const total = money(order.total_price, order.currency);
  const name = String(order.name || `#${order.id ?? ""}`).trim();
  await sendPush(pool, {
    kind: "orders",
    title: `New Shopify order ${name}${total ? ` · ${total}` : ""}`,
    body: [items ? `${items} item${items === 1 ? "" : "s"}` : "", first ? `${first}${(order.line_items?.length ?? 0) > 1 ? " and more" : ""}` : ""].filter(Boolean).join(" · ") || "Paid order",
    url: "/shopify/sales",
    tag: `order-${order.id ?? name}`,
    sound: "orders",
  });
}

/**
 * One alert per run in a batch that just finished saving:
 * "Studio · Pablo Pants · Victor BLACK — 4 pictures ready".
 */
export async function notifyStudioBatchResults(pool: Pool, batchId: string, tenantId: string): Promise<void> {
  try {
    const rows = (
      await pool.query<{ matrix_id: string; product_name: string | null; model_name: string | null; item_colour: string | null; results: Record<string, { path?: string; error?: string }> | null; panel_count: number }>(
        `SELECT i.matrix_id::text, m.description AS product_name, i.model_name, i.item_colour, i.results,
                jsonb_array_length(i.panels) AS panel_count
           FROM studio_batch_items i JOIN matrices m ON m.id = i.matrix_id
          WHERE i.batch_id = $1::uuid AND i.status <> 'cancelled'`, // a stopped run sends no alert
        [batchId],
      )
    ).rows;
    for (const r of rows) {
      const res = Object.values(r.results ?? {});
      const ready = res.filter((v) => v?.path).length;
      const failed = res.filter((v) => !v?.path && v?.error).length;
      const who = [r.model_name, r.item_colour].filter(Boolean).join(" ");
      await sendPush(
        pool,
        {
          kind: "studio",
          title: `Studio · ${r.product_name || "Product"}${who ? ` · ${who}` : ""}`,
          body: ready
            ? `${ready} of ${r.panel_count} picture${r.panel_count === 1 ? "" : "s"} ready${failed ? ` · ${failed} failed` : ""} — tap to review`
            : `The run finished but no pictures were made${failed ? ` (${failed} failed)` : ""}`,
          // Bulk Studio › Upload lists every run that came back, ready to review and publish (owner 2026-10-22).
          url: "/inventory/bulk-studio?tab=upload",
          tag: `studio-${batchId}-${r.matrix_id}-${(r.item_colour || "").replace(/\s+/g, "")}`,
          sound: "studio",
        },
        { tenantId },
      );
    }
  } catch (e) {
    console.warn("[web-push] studio alert skipped:", e instanceof Error ? e.message : e);
  }
}
