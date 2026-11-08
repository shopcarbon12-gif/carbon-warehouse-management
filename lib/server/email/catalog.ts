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
  handle: string;
  /** Matching-set partners (handles, from the carbon_set.partners metafield CarbonWMS writes). */
  setPartners: string[];
};

/**
 * A matching set, shown the way the homepage set card shows it (theme
 * snippets/carbon-set-card.liquid): one card named "<Name> Set", a piece badge,
 * the pieces line "Hoodie $52 + Jogger $49" (tops first, bottoms last), the
 * total "Set $101", the top's photo, linked to the top's page.
 */
export type CatalogSet = {
  ref: string; // X1, X2 …
  name: string;
  pieces: CatalogProduct[]; // tops first, bottoms last
  piecesLine: string;
  total: number;
  lead: CatalogProduct;
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
  partners: { value: string } | null;
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
                 featuredMedia { preview { image { url } } } options { name values }
                 partners: metafield(namespace: "carbon_set", key: "partners") { value } } } }`,
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
        handle: n.handle,
        setPartners: partnersOf(n.partners?.value),
      };
    });
  cache = { at: Date.now(), items };
  return items;
}

function partnersOf(v: string | null | undefined): string[] {
  try {
    const a = JSON.parse(v || "[]") as unknown;
    return Array.isArray(a) ? a.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Same rule as the homepage set card: a piece whose last word (without " Set") is one of these is a bottom. */
const BOTTOMS = new Set(["Pants", "Jogger", "Joggers", "Skirt", "Shorts", "Short", "Leggings", "Legging", "Trousers", "Trouser"]);
const pieceWord = (title: string) => title.replace(/ Set$/i, "").trim().split(/\s+/).pop() ?? title;

/** Matching sets whose pieces are all in stock (X-refs), like the homepage set cards. */
export function catalogSets(items: CatalogProduct[]): CatalogSet[] {
  const byHandle = new Map(items.map((p) => [p.handle, p]));
  const seen = new Set<string>();
  const sets: CatalogSet[] = [];
  for (const p of items) {
    if (!p.setPartners.length || seen.has(p.handle)) continue;
    const all = [p, ...p.setPartners.map((h) => byHandle.get(h))];
    if (all.some((x) => !x)) continue; // a piece is sold out: no set card
    const pieces = (all as CatalogProduct[]).filter((x, i, a) => a.findIndex((y) => y.handle === x.handle) === i);
    if (pieces.length < 2) continue;
    pieces.forEach((x) => seen.add(x.handle));
    const ordered = [...pieces.filter((x) => !BOTTOMS.has(pieceWord(x.title))), ...pieces.filter((x) => BOTTOMS.has(pieceWord(x.title)))];
    const lead = ordered[0];
    const words = lead.title.replace(/ Set$/i, "").trim().split(/\s+/);
    const name = words.length > 1 ? `${words.slice(0, -1).join(" ")} Set` : lead.title;
    const money = (n: number) => `$${n % 1 ? n.toFixed(2) : n}`;
    const total = Math.round(ordered.reduce((s, x) => s + x.price, 0) * 100) / 100;
    sets.push({ ref: `X${sets.length + 1}`, name, pieces: ordered, piecesLine: ordered.map((x) => `${pieceWord(x.title)} ${money(x.price)}`).join(" + "), total, lead });
  }
  return sets;
}

/** One line per product for the planner (short: ~600 products ≈ 6k tokens), then the sets. */
export function catalogLines(items: CatalogProduct[], sets: CatalogSet[] = catalogSets(items)): string {
  const setOf = new Map<string, string>();
  for (const s of sets) for (const p of s.pieces) setOf.set(p.id, s.ref);
  const lines = items.map(
    (p) =>
      `${p.ref} | ${p.title} | ${p.type || "item"} | ${p.gender} | ${p.colors.join("/") || "-"} | $${p.price}${p.compareAt && p.compareAt > p.price ? ` (was $${p.compareAt})` : ""} | stock ${p.stock}${setOf.has(p.id) ? ` | piece of set ${setOf.get(p.id)}` : ""}`,
  );
  if (!sets.length) return lines.join("\n");
  return (
    lines.join("\n") +
    `\n\nMATCHING SETS (${sets.length}) — ref | set name | pieces line | set total | pieces (top first):\n` +
    sets.map((s) => `${s.ref} | ${s.name} | ${s.piecesLine} | Set $${s.total % 1 ? s.total.toFixed(2) : s.total} | ${s.pieces.map((p) => p.ref).join(" + ")}`).join("\n")
  );
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
