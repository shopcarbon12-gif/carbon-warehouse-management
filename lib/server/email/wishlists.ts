/**
 * CarbonWMS Email — wishlist emails (owner's CARBON pack 46 back in stock, 47 price drop, 48 wishlist).
 *
 * Logged-in shoppers' wishlists already live in Shopify (customer metafield carbon.wishlist, written
 * by /api/wishlist from the theme's heart buttons). Once an hour, while a wishlist flow is on,
 * syncWishlists copies them into email_wishlist_items with each saved variant's price and
 * availability; the three trigger readers then find:
 *   wishlistIdle  — a list left alone for N days, no order since;
 *   backInStock   — a saved variant that was sold out and is available again;
 *   priceDrop     — a saved variant now at least 5% under the price it had when saved.
 */
import type { Pool } from "pg";
import { welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { normalizeEmail } from "@/lib/server/welcome/rules";
import type { ProductItem } from "@/lib/email-editor/types";

const SYNC_EVERY_MS = 60 * 60_000;

type Saved = { email: string; first: string | null; changedAt: string; variants: string[] };
type Variant = { id: string; price: string; availableForSale: boolean; image: { url: string } | null; product: { title: string; handle: string; onlineStoreUrl: string | null; featuredImage: { url: string } | null } };

export async function syncWishlists(pool: Pool, tenantId: string, force = false): Promise<number> {
  const st = await pool.query<{ value: string }>(`SELECT value FROM email_flow_state WHERE tenant_id = $1::uuid AND key = 'wishlist_synced_at'`, [tenantId]);
  if (!force && st.rows[0] && Date.now() - new Date(st.rows[0].value).getTime() < SYNC_EVERY_MS) return 0;
  await pool.query(
    `INSERT INTO email_flow_state (tenant_id, key, value) VALUES ($1::uuid, 'wishlist_synced_at', $2) ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [tenantId, new Date().toISOString()],
  );
  const ctx = await welcomeShopCtx();
  if (!ctx) return 0;
  const lists: Saved[] = [];
  let after: string | null = null;
  for (let page = 0; page < 80; page++) {
    const d: {
      customers: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: { firstName: string | null; defaultEmailAddress: { emailAddress: string } | null; metafield: { value: string; updatedAt: string } | null }[];
      };
    } = await welcomeGql(
      ctx,
      `query WL($a: String) { customers(first: 250, after: $a) { pageInfo { hasNextPage endCursor }
         nodes { firstName defaultEmailAddress { emailAddress } metafield(namespace: "carbon", key: "wishlist") { value updatedAt } } } }`,
      { a: after },
    );
    for (const c of d.customers.nodes) {
      const email = normalizeEmail(c.defaultEmailAddress?.emailAddress);
      if (!email || !c.metafield) continue;
      let items: { v?: string }[] = [];
      try {
        items = JSON.parse(c.metafield.value);
      } catch {
        continue;
      }
      const variants = items.map((x) => String(x.v ?? "")).filter((v) => /^\d+$/.test(v)).slice(0, 100);
      lists.push({ email, first: c.firstName, changedAt: c.metafield.updatedAt, variants });
    }
    if (!d.customers.pageInfo.hasNextPage) break;
    after = d.customers.pageInfo.endCursor;
  }
  const ids = [...new Set(lists.flatMap((l) => l.variants))].map((v) => `gid://shopify/ProductVariant/${v}`);
  const info = new Map<string, Variant>();
  for (let i = 0; i < ids.length; i += 100) {
    const d: { nodes: (Variant | null)[] } = await welcomeGql(
      ctx,
      `query V($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id price availableForSale image { url } product { title handle onlineStoreUrl featuredImage { url } } } } }`,
      { ids: ids.slice(i, i + 100) },
    );
    for (const v of d.nodes) if (v?.id) info.set(v.id, v);
  }
  let rows = 0;
  for (const l of lists) {
    const keep: string[] = [];
    for (const v of l.variants) {
      const gid = `gid://shopify/ProductVariant/${v}`;
      const x = info.get(gid);
      if (!x) continue; // a deleted product: leave it out
      keep.push(gid);
      const price = Number(x.price) || null;
      await pool.query(
        `INSERT INTO email_wishlist_items (tenant_id, email, variant_gid, first_name, handle, title, image, url, first_price, last_price, was_available, available, list_changed_at, checked_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $10, $11, now())
         ON CONFLICT (tenant_id, email, variant_gid) DO UPDATE SET
           first_name = EXCLUDED.first_name, handle = EXCLUDED.handle, title = EXCLUDED.title, image = EXCLUDED.image, url = EXCLUDED.url,
           last_price = EXCLUDED.last_price, was_available = email_wishlist_items.available, available = EXCLUDED.available,
           list_changed_at = EXCLUDED.list_changed_at, checked_at = now()`,
        [
          tenantId,
          l.email,
          gid,
          l.first,
          x.product.handle,
          x.product.title,
          x.image?.url ?? x.product.featuredImage?.url ?? null,
          x.product.onlineStoreUrl ?? `https://shopcarbon.com/products/${x.product.handle}`,
          price,
          x.availableForSale,
          l.changedAt,
        ],
      );
      rows++;
    }
    await pool.query(`DELETE FROM email_wishlist_items WHERE tenant_id = $1::uuid AND email = $2 AND NOT (variant_gid = ANY($3::text[]))`, [tenantId, l.email, keep]);
  }
  return rows;
}

type Person = { email: string; firstName: string | null; key: string; at: Date; data: Record<string, unknown> };
type Row = { email: string; first_name: string | null; variant_gid: string; title: string | null; image: string | null; url: string | null; first_price: string | null; last_price: string | null; list_changed_at: Date | null };

const item = (r: Row, showDrop = false): ProductItem => ({
  id: r.variant_gid,
  title: r.title ?? "",
  price: Number(r.last_price ?? 0),
  compareAt: showDrop && r.first_price && Number(r.first_price) > Number(r.last_price) ? Number(r.first_price) : null,
  image: r.image,
  url: r.url ?? "https://shopcarbon.com",
  set: null,
});

/** Lists left alone for `days` days with something still available, and no order since. */
export async function wishlistIdle(pool: Pool, tenantId: string, days: number): Promise<Person[]> {
  const r = await pool.query<Row>(
    `SELECT w.* FROM email_wishlist_items w
      WHERE w.tenant_id = $1::uuid AND w.available AND w.list_changed_at < now() - make_interval(days => $2::int)
        AND NOT EXISTS (SELECT 1 FROM email_orders_seen o WHERE o.tenant_id = w.tenant_id AND o.email = w.email AND o.processed_at > w.list_changed_at)
      ORDER BY w.email, w.saved_at`,
    [tenantId, days],
  );
  const by = new Map<string, Row[]>();
  for (const x of r.rows) by.set(x.email, [...(by.get(x.email) ?? []), x]);
  return [...by.values()].map((rs) => ({
    email: rs[0].email,
    firstName: rs[0].first_name,
    key: `wishlist:${rs[0].email}:${rs[0].list_changed_at?.toISOString() ?? ""}`,
    at: new Date(),
    data: { items: rs.slice(0, 6).map((x) => item(x)) },
  }));
}

/** Saved variants that were sold out at the last check and are available now. */
export async function backInStock(pool: Pool, tenantId: string): Promise<Person[]> {
  const r = await pool.query<Row>(`SELECT * FROM email_wishlist_items WHERE tenant_id = $1::uuid AND was_available = false AND available = true`, [tenantId]);
  const day = new Date().toISOString().slice(0, 10);
  return r.rows.map((x) => ({ email: x.email, firstName: x.first_name, key: `back:${x.email}:${x.variant_gid}:${day}`, at: new Date(), data: { items: [item(x)] } }));
}

/** Saved variants now at least 5% under the price they had when saved (once per new price). */
export async function priceDrop(pool: Pool, tenantId: string): Promise<Person[]> {
  const r = await pool.query<Row>(
    `SELECT * FROM email_wishlist_items WHERE tenant_id = $1::uuid AND available AND first_price > 0 AND last_price <= first_price * 0.95`,
    [tenantId],
  );
  return r.rows.map((x) => ({ email: x.email, firstName: x.first_name, key: `drop:${x.email}:${x.variant_gid}:${x.last_price}`, at: new Date(), data: { items: [item(x, true)] } }));
}
