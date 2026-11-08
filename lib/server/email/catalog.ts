/**
 * CarbonWMS Email — the real catalog and the real logo for the AI Designer
 * (owner, 2026-11-07: "go through the catalog … pick items and make a
 * styling … in one prompt", and "always the real Carbon logo").
 *
 * Catalog: every ACTIVE Shopify product with stock (Shopify's stock comes from
 * the WMS), with its real photo, price, colours and how many are in stock.
 * Kept in memory for 20 minutes. The planner sees it as a short list and must
 * pick real items (never invent clothing); the picked products' photos go to
 * the picture model as references, and the converter links them to their real
 * product pages.
 *
 * Logo: public/email/carbon-logo-{long,stacked}-{black,white}.png — the long
 * hexagon + CARBON wordmark from the storefront header (Shopify file
 * CARBON_JEANS_white_NEW…png, 9357×2801), recoloured. The picture model gets it
 * as a reference, and "Convert to email" always uses the real file instead of
 * a cut-out of the drawn one.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { WMS_BASE } from "./config";

export type CatalogProduct = {
  ref: string;
  id: string;
  title: string;
  url: string;
  type: string;
  gender: "men" | "women" | "unisex";
  colors: string[];
  sizes: string[];
  price: number;
  compareAt: number | null;
  stock: number;
  image: string | null;
};

export const LOGO_URLS = {
  longBlack: `${WMS_BASE}/email/carbon-logo-long-black.png`,
  longWhite: `${WMS_BASE}/email/carbon-logo-long-white.png`,
  stackedBlack: `${WMS_BASE}/email/carbon-logo-stacked-black.png`,
  stackedWhite: `${WMS_BASE}/email/carbon-logo-stacked-white.png`,
};

let cache: { at: number; items: CatalogProduct[] } | null = null;
const TTL = 20 * 60_000;

function genderOf(tags: string[]): CatalogProduct["gender"] {
  const t = tags.map((x) => x.toLowerCase());
  const men = t.some((x) => x === "men" || x === "mens" || x === "men's");
  const women = t.some((x) => x === "women" || x === "womens" || x === "women's");
  return men && !women ? "men" : women && !men ? "women" : "unisex";
}

type Node = {
  id: string;
  title: string;
  handle: string;
  productType: string;
  tags: string[];
  totalInventory: number | null;
  onlineStoreUrl: string | null;
  priceRangeV2: { minVariantPrice: { amount: string } };
  compareAtPriceRange: { minVariantCompareAtPrice: { amount: string } } | null;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  options: { name: string; values: string[] }[];
};

/** Every active, in-stock product (refs P1, P2 … stable for one listing). */
export async function inStockCatalog(): Promise<CatalogProduct[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.items;
  const ctx = await welcomeShopCtx();
  if (!ctx) throw new Error("Shopify is not connected");
  const nodes: Node[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const d: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Node[] } } = await welcomeGql(
      ctx,
      `query Cat($after: String) { products(first: 250, after: $after, query: "status:active inventory_total:>0", sortKey: CREATED_AT, reverse: true) {
         pageInfo { hasNextPage endCursor }
         nodes { id title handle productType tags totalInventory onlineStoreUrl
                 priceRangeV2 { minVariantPrice { amount } } compareAtPriceRange { minVariantCompareAtPrice { amount } }
                 featuredMedia { preview { image { url } } } options { name values } } } }`,
      { after },
    );
    nodes.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  const items = nodes
    .filter((n) => n.featuredMedia?.preview?.image?.url)
    .map((n, i) => {
      const compare = Number(n.compareAtPriceRange?.minVariantCompareAtPrice?.amount ?? 0);
      return {
        ref: `P${i + 1}`,
        id: n.id,
        title: n.title,
        url: n.onlineStoreUrl ?? `https://shopcarbon.com/products/${n.handle}`,
        type: (n.productType || "").toLowerCase(),
        gender: genderOf(n.tags),
        colors: n.options.find((o) => /colou?r/i.test(o.name))?.values ?? [],
        sizes: n.options.find((o) => /size/i.test(o.name))?.values ?? [],
        price: Number(n.priceRangeV2.minVariantPrice.amount),
        compareAt: compare > 0 ? compare : null,
        stock: n.totalInventory ?? 0,
        image: n.featuredMedia?.preview?.image?.url ?? null,
      };
    });
  cache = { at: Date.now(), items };
  return items;
}

/** One line per product for the planner (short: ~600 products ≈ 6k tokens). */
export function catalogLines(items: CatalogProduct[]): string {
  return items
    .map((p) => `${p.ref} | ${p.title} | ${p.type || "item"} | ${p.gender} | ${p.colors.join("/") || "-"} | $${p.price}${p.compareAt && p.compareAt > p.price ? ` (was $${p.compareAt})` : ""} | stock ${p.stock}`)
    .join("\n");
}

/** A product photo, ready as a picture-model reference (1024 px, JPEG). */
export async function productPhoto(p: CatalogProduct): Promise<Buffer | null> {
  if (!p.image) return null;
  const u = new URL(p.image);
  u.searchParams.set("width", "1024");
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r?.ok) return null;
  return sharp(Buffer.from(await r.arrayBuffer())).rotate().resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}

let logoRef: Buffer | null = null;
/** The real long logo, black on white (a transparent PNG would turn black on black as JPEG). */
export async function logoReference(): Promise<Buffer> {
  if (logoRef) return logoRef;
  let png: Buffer | null = null;
  try {
    png = await readFile(path.join(process.cwd(), "public/email/carbon-logo-long-black.png"));
  } catch {
    const r = await fetch(LOGO_URLS.longBlack, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
    if (r?.ok) png = Buffer.from(await r.arrayBuffer());
  }
  if (!png) throw new Error("The Carbon logo file could not be read");
  logoRef = await sharp(png).flatten({ background: "#ffffff" }).extend({ top: 60, bottom: 60, left: 60, right: 60, background: "#ffffff" }).jpeg({ quality: 95 }).toBuffer();
  return logoRef;
}

/** Every photo of some products (front, side, back, details), newest listing order kept. */
export async function productGallery(ids: string[], perProduct = 4): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const ctx = await welcomeShopCtx();
  if (!ctx) return out;
  const d: { nodes: ({ id: string; media?: { nodes: { preview?: { image?: { url: string } | null } | null }[] } } | null)[] } = await welcomeGql(
    ctx,
    `query Gal($ids: [ID!]!, $n: Int!) { nodes(ids: $ids) { ... on Product { id media(first: $n) { nodes { preview { image { url } } } } } } }`,
    { ids: ids.slice(0, 50), n: perProduct },
  );
  for (const n of d.nodes) {
    if (!n?.media) continue;
    out.set(n.id, n.media.nodes.map((m) => m.preview?.image?.url).filter((u): u is string => !!u));
  }
  return out;
}

/** Any picture URL (Shopify CDN or our own), as a picture-model reference (1024 px JPEG on white). */
export async function referencePhoto(url: string, width = 1024): Promise<Buffer | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname.endsWith("shopify.com") || u.hostname.endsWith("shopcarbon.com")) u.searchParams.set("width", String(width));
  const r = await fetch(u, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!r?.ok) return null;
  return sharp(Buffer.from(await r.arrayBuffer())).rotate().flatten({ background: "#ffffff" }).resize({ width, withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}
