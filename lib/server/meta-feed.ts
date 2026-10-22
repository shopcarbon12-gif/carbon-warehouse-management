/**
 * Meta close-up picture feed (owner 2026-10-22). Facebook / Instagram catalog
 * ads show each product in a square card; Shopify's Facebook & Instagram app
 * sends the full-length photo padded to a square, so the model comes out
 * small with white at the sides. This builds a supplementary feed for the
 * Meta catalog that gives each variant a front close-up of its own colour
 * instead (cropped square by /api/storefront/meta-feed/image). Variants with
 * no close-up are left out, so Meta keeps Shopify's picture for them.
 *
 * Colour blocks follow the store's photo order: a colour's photos start at its
 * variant picture and run to the next colour's variant picture.
 */
import OpenAI from "openai";
import type { Pool } from "pg";
import { runShopifyGraphql } from "@/lib/shopify";
import { resolveShopContext } from "@/lib/server/shopify-write";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { classifyPhotoViews, photoKey, type PhotoView } from "@/lib/server/photo-views";

const REBUILD_MS = 6 * 60 * 60_000;
/** Photos looked at per colour when hunting for its close-up. */
const LOOK_AHEAD = 4;

type RawProduct = {
  id: string;
  media: { nodes: Array<{ image?: { url: string } | null }> };
  variants: { nodes: Array<{ id: string; image: { url: string } | null }> };
};

const num = (gid: string) => gid.split("/").pop() || gid;

async function activeProducts(): Promise<RawProduct[]> {
  const ctx = await resolveShopContext();
  if (!ctx) throw new Error("Shopify is not connected");
  const out: RawProduct[] = [];
  let after: string | null = null;
  for (let page = 0; page < 500; page++) {
    const res = (await runShopifyGraphql({
      shop: ctx.shop,
      token: ctx.token,
      apiVersion: ctx.apiVersion,
      query: `query($after: String) {
        products(first: 8, after: $after, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes { id
            media(first: 40) { nodes { ... on MediaImage { image { url } } } }
            variants(first: 60) { nodes { id image { url } } } }
        }
      }`,
      variables: { after },
    })) as { data?: { products: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: RawProduct[] } } | null };
    const conn = res.data?.products;
    if (!conn) throw new Error("Could not read products from Shopify");
    out.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/** For each variant: the photos of its colour after its own picture, in order. */
export function colourBlocks(p: RawProduct): Array<{ variantId: string; candidates: string[] }> {
  const media = p.media.nodes.map((m) => m.image?.url).filter((u): u is string => !!u);
  const keys = media.map(photoKey);
  const starts = [
    ...new Set(
      p.variants.nodes
        .map((v) => (v.image ? keys.indexOf(photoKey(v.image.url)) : -1))
        .filter((i) => i >= 0),
    ),
  ].sort((a, b) => a - b);
  return p.variants.nodes.map((v) => {
    const at = v.image ? keys.indexOf(photoKey(v.image.url)) : 0;
    const start = at >= 0 ? at : 0;
    const end = starts.find((s) => s > start) ?? media.length;
    return { variantId: num(v.id), candidates: media.slice(start + 1, end).slice(0, LOOK_AHEAD) };
  });
}

export async function buildMetaFeed(pool: Pool): Promise<{ products: number; variants: number; rows: number }> {
  const products = await activeProducts();
  const blocks = products.flatMap((p) => colourBlocks(p).map((b) => ({ ...b, productId: num(p.id) })));

  const wanted = [...new Map(blocks.flatMap((b) => b.candidates).map((u) => [photoKey(u), u])).values()];
  const known = new Map<string, PhotoView>();
  for (let i = 0; i < wanted.length; i += 1000) {
    const r = await pool.query<{ image_key: string; view: PhotoView }>(
      `SELECT image_key, view FROM meta_feed_views WHERE image_key = ANY($1::text[])`,
      [wanted.slice(i, i + 1000).map(photoKey)],
    );
    for (const row of r.rows) known.set(row.image_key, row.view);
  }
  const todo = wanted.filter((u) => !known.has(photoKey(u)));
  const apiKey = (getOpenAiApiKey() || "").trim();
  if (todo.length && apiKey) {
    const fresh = await classifyPhotoViews(new OpenAI({ apiKey }), todo);
    for (const [k, v] of fresh) {
      known.set(k, v);
      await pool.query(
        `INSERT INTO meta_feed_views (image_key, view) VALUES ($1, $2)
         ON CONFLICT (image_key) DO UPDATE SET view = EXCLUDED.view, classified_at = now()`,
        [k, v],
      );
    }
  }

  const rows = blocks
    .map((b) => ({ ...b, src: b.candidates.find((u) => known.get(photoKey(u)) === "front-close") }))
    .filter((b): b is typeof b & { src: string } => !!b.src);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM meta_feed_rows");
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      await client.query(
        `INSERT INTO meta_feed_rows (variant_id, product_id, src)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])`,
        [part.map((r) => r.variantId), part.map((r) => r.productId), part.map((r) => r.src)],
      );
    }
    await client.query(
      `UPDATE meta_feed_state SET built_at = now(), products = $1, variants = $2, rows = $3, error = NULL WHERE id = 1`,
      [products.length, blocks.length, rows.length],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return { products: products.length, variants: blocks.length, rows: rows.length };
}

let lastTick = 0;

/** Called on every worker loop; rebuilds the feed every 6 hours. */
export async function maybeRunMetaFeed(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastTick < 10 * 60_000) return;
  lastTick = now;
  try {
    const s = await pool.query<{ built_at: Date | null }>(`SELECT built_at FROM meta_feed_state WHERE id = 1`);
    const built = s.rows[0]?.built_at;
    if (built && now - new Date(built).getTime() < REBUILD_MS) return;
    const r = await buildMetaFeed(pool);
    console.log(`[worker] meta feed: ${r.rows} close-ups for ${r.variants} variants (${r.products} products)`);
  } catch (e) {
    console.error("[worker] meta feed build failed", e);
    await pool
      .query(`UPDATE meta_feed_state SET error = $1 WHERE id = 1`, [String((e as Error)?.message || e).slice(0, 500)])
      .catch(() => {});
  }
}
