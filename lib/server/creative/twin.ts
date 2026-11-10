/**
 * CarbonWMS Creative — Product Twin (spec §6). Built the first time a product is used, cached
 * forever: every Shopify picture + title, description, fabric, fit, price, variants, collection;
 * garment-only cut-outs per angle (no model, no background — the Shopify model never appears in
 * any output); detail crops (logo/graphic, stitching, wash, hardware, texture); and the facts
 * sheet — the ONLY facts the copywriter may use. The owner confirms once with ✓, or uploads a
 * flat-lay / hanger photo for a bad cut-out.
 */
import type { Pool } from "pg";
import sharp from "sharp";
import { z } from "zod";
import { welcomeGql, welcomeShopCtx } from "@/lib/server/welcome/config";
import { PlainError, recordSpend, spendGate } from "./config";
import { generateImage } from "./engines";
import { json } from "./llm";
import { appFileUrl, fetchBytes, putFile, getFile } from "./storage";
import type { JobHandler } from "./jobs";
import { IMAGE_COST } from "./routing";

type ShopProduct = {
  id: string;
  title: string;
  handle: string;
  description: string;
  productType: string;
  vendor: string;
  tags: string[];
  onlineStoreUrl: string | null;
  totalInventory: number | null;
  options: { name: string; values: string[] }[];
  priceRangeV2: { minVariantPrice: { amount: string }; maxVariantPrice: { amount: string } };
  compareAtPriceRange: { minVariantCompareAtPrice: { amount: string } | null } | null;
  collections: { nodes: { title: string; handle: string }[] };
  media: { nodes: { alt: string | null; preview?: { image?: { url: string; width: number; height: number } | null } | null }[] };
  variants: { nodes: { title: string; price: string; inventoryQuantity: number | null; selectedOptions: { name: string; value: string }[] }[] };
  metafields: { nodes: { namespace: string; key: string; value: string }[] };
};

export async function shopProduct(productId: string): Promise<ShopProduct | null> {
  const ctx = await welcomeShopCtx();
  if (!ctx) throw new PlainError("Shopify is not connected.");
  const d = await welcomeGql<{ product: ShopProduct | null }>(
    ctx,
    `query P($id: ID!) { product(id: $id) {
       id title handle description productType vendor tags onlineStoreUrl totalInventory
       options { name values }
       priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
       compareAtPriceRange { minVariantCompareAtPrice { amount } }
       collections(first: 10) { nodes { title handle } }
       media(first: 20) { nodes { alt preview { image { url width height } } } }
       variants(first: 100) { nodes { title price inventoryQuantity selectedOptions { name value } } }
       metafields(first: 40) { nodes { namespace key value } }
     } }`,
    { id: productId },
  );
  return d.product;
}

const ANGLES = ["front", "back", "detail", "side", "flatlay", "other"] as const;
const PhotoPlan = z.object({
  photos: z.array(
    z.object({
      index: z.number().int(),
      angle: z.enum(ANGLES),
      has_person: z.boolean(),
      usable: z.boolean(),
      details: z.array(z.object({ kind: z.enum(["logo_graphic", "stitching", "wash", "hardware", "texture", "label"]), box: z.array(z.number()).length(4), note: z.string() })).max(4),
    }),
  ),
  visible_facts: z.array(z.string()).max(14),
  garment: z.string(),
  colors_seen: z.array(z.string()).max(6),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a creative_product_twins row
export function twinView(t: Record<string, any> | null) {
  if (!t) return null;
  return {
    productId: t.product_id,
    handle: t.handle,
    title: t.title,
    status: t.status,
    error: t.error,
    facts: t.facts,
    sourceImages: t.source_images,
    cutouts: (t.cutouts ?? []).map((c: { angle: string; storage_path: string; from: string }) => ({ ...c, url: appFileUrl(c.storage_path) })),
    details: (t.details ?? []).map((d: { kind: string; storage_path: string; note?: string }) => ({ ...d, url: appFileUrl(d.storage_path) })),
    confirmedAt: t.confirmed_at,
    confirmedBy: t.confirmed_by,
  };
}

export async function getTwin(pool: Pool, tenantId: string, productId: string) {
  const r = await pool.query(`SELECT * FROM creative_product_twins WHERE tenant_id = $1::uuid AND product_id = $2`, [tenantId, productId]);
  return r.rows[0] ?? null;
}

/** Estimated cost to build a twin: one vision call + up to 3 cut-outs at high quality. */
export const TWIN_COST_ESTIMATE = 0.05 + 3 * IMAGE_COST.high;

const strip = (s: string) => s.replace(/\s+/g, " ").trim();

export function factsFrom(p: ShopProduct, seen: { visible_facts: string[]; garment: string; colors_seen: string[] } | null) {
  const meta = Object.fromEntries(p.metafields.nodes.filter((m) => !/^(seo|shield|wishlist)/i.test(m.namespace) && m.value.length < 400).map((m) => [`${m.namespace}.${m.key}`, m.value]));
  const fabric = /(\d{1,3}%\s*[a-z]+(?:[\s,/]+\d{1,3}%\s*[a-z]+)*)/i.exec(p.description)?.[1] ?? meta["custom.fabric"] ?? meta["carbon.fabric"] ?? null;
  const price = Number(p.priceRangeV2.minVariantPrice.amount);
  const compare = Number(p.compareAtPriceRange?.minVariantCompareAtPrice?.amount ?? 0);
  return {
    title: p.title,
    url: p.onlineStoreUrl ?? `https://shopcarbon.com/products/${p.handle}`,
    type: p.productType,
    description: strip(p.description).slice(0, 1500),
    fabric,
    fit: meta["custom.fit"] ?? meta["carbon.fit"] ?? (/(slim|skinny|relaxed|baggy|oversized|straight|regular|cropped|wide)[ -](fit|leg)/i.exec(p.description)?.[0] ?? null),
    price,
    compareAt: compare > price ? compare : null,
    colors: p.options.find((o) => /colou?r/i.test(o.name))?.values ?? [],
    sizes: p.options.find((o) => /size/i.test(o.name))?.values ?? [],
    inStock: p.totalInventory ?? null,
    collections: p.collections.nodes.map((c) => c.title),
    tags: p.tags,
    seenInPhotos: seen?.visible_facts ?? [],
    garment: seen?.garment ?? p.productType,
    rule: "Copy may use ONLY these facts. No invented claims, reviews, ratings, stats or origin.",
  };
}

/** twin_build: Shopify → photo plan (vision) → cut-outs + detail crops → ready for the owner's ✓. */
export const twinBuild: JobHandler = async (pool, job, setProgress) => {
  const { productId } = job.payload as { productId: string };
  const tid = job.tenant_id;
  await setProgress("Reading the product from Shopify");
  const p = await shopProduct(productId);
  if (!p) throw new PlainError("That product is not in Shopify any more.");
  const images = p.media.nodes.map((m) => m.preview?.image).filter((x): x is { url: string; width: number; height: number } => Boolean(x?.url));
  await pool.query(
    `INSERT INTO creative_product_twins (tenant_id, product_id, handle, title, status, source_images) VALUES ($1::uuid, $2, $3, $4, 'building', $5::jsonb)
     ON CONFLICT (tenant_id, product_id) DO UPDATE SET handle = EXCLUDED.handle, title = EXCLUDED.title, status = 'building', source_images = EXCLUDED.source_images, error = NULL, updated_at = now()`,
    [tid, productId, p.handle, p.title, JSON.stringify(images.map((i) => i.url))],
  );
  if (!images.length) {
    await pool.query(`UPDATE creative_product_twins SET status = 'no_images', facts = $3::jsonb, error = $4, updated_at = now() WHERE tenant_id = $1::uuid AND product_id = $2`, [
      tid, productId, JSON.stringify(factsFrom(p, null)), "This product has no pictures in Shopify. Upload a flat-lay or hanger photo to use it.",
    ]);
    return { status: "done", progress: "No pictures in Shopify — upload a flat-lay or hanger photo" };
  }
  await spendGate(pool, tid, "openai", TWIN_COST_ESTIMATE);
  const srcs = images.slice(0, 10);
  const small: Buffer[] = [];
  for (const im of srcs) {
    const u = new URL(im.url);
    u.searchParams.set("width", "1024");
    small.push(await sharp((await fetchBytes(u.toString(), 30 * 1024 * 1024)).bytes).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 85 }).toBuffer());
  }
  await setProgress("Looking at every picture (angles, details)");
  const plan = (
    await json(
      pool,
      [
        `These are the ${small.length} Shopify pictures of "${p.title}" (${p.productType}), in order (index 0…${small.length - 1}).`,
        "For each picture: angle (front / back / detail / side / flatlay / other), has_person (a model is wearing or holding it), usable (sharp, garment fully visible).",
        "details: up to 4 boxes [x0,y0,x1,y1] as fractions 0–1 of the picture, around the logo/graphic, stitching, wash, hardware, texture or label — only what is really there.",
        "visible_facts: short facts you can SEE (e.g. 'five-pocket', 'silver rivets', 'raw hem', 'front graphic: CARBON in white'). Never guess fabric content or anything you can't see.",
        "garment: what it is in a few words. colors_seen: colour names.",
      ].join("\n"),
      PhotoPlan,
      { tenantId: tid, what: `product twin: photo plan (${p.title})`, images: small.map((b) => ({ b64: b.toString("base64") })), maxOutputTokens: 3000 },
    )
  ).value;
  const facts = factsFrom(p, plan);
  const pick = (angle: string) => plan.photos.filter((x) => x.angle === angle && x.usable).sort((a, b) => Number(a.has_person) - Number(b.has_person))[0];
  const chosen = [pick("front") ?? pick("flatlay") ?? plan.photos.find((x) => x.usable), pick("back"), pick("detail")].filter(Boolean) as z.infer<typeof PhotoPlan>["photos"];
  const cutouts: { angle: string; storage_path: string; from: string }[] = [];
  for (const ph of chosen) {
    const src = small[ph.index];
    if (!src) continue;
    const angle = ph.angle === "flatlay" ? "front" : ph.angle;
    if (cutouts.some((c) => c.angle === angle)) continue;
    await setProgress(`Cutting out the garment (${angle})`);
    let bytes: Buffer;
    if (!ph.has_person && (ph.angle === "flatlay" || ph.angle === "detail")) {
      bytes = await sharp(src).png().toBuffer(); // already garment-only
    } else {
      const g = await generateImage({
        prompt: [
          `Product cut-out of the ${plan.garment} in the reference photo, ${angle} view, as a ghost-mannequin / invisible-mannequin e-commerce shot on pure white (#ffffff).`,
          "REMOVE the person completely: no face, skin, hands, hair, body or shoes unless they are the product. No background, no props, no shadow except a faint contact shadow.",
          "Keep the garment EXACTLY as photographed: same colour and wash, same graphic / logo / text letter-for-letter, same stitching, hardware, pockets, length, fit and proportions. Do not redesign, add or remove anything.",
        ].join(" "),
        refs: [{ name: "garment.jpg", bytes: src, mime: "image/jpeg" }],
        size: "1024x1536",
        quality: "high",
      });
      await recordSpend(pool, tid, { provider: "openai", what: `product twin cut-out (${p.title}, ${angle})`, cost: g.cost });
      bytes = g.bytes;
    }
    const path = await putFile(`creative/twins/${tid}/${p.handle}/cutout-${angle}.png`, bytes, "image/png");
    cutouts.push({ angle, storage_path: path, from: `shopify #${ph.index}` });
  }
  await setProgress("Cropping the details");
  const details: { kind: string; storage_path: string; note: string }[] = [];
  for (const ph of plan.photos)
    for (const [k, d] of ph.details.entries()) {
      const src = small[ph.index];
      if (!src || details.length >= 8) continue;
      const meta = await sharp(src).metadata();
      const W = meta.width ?? 1024, H = meta.height ?? 1024;
      const [x0, y0, x1, y1] = d.box.map((v) => Math.max(0, Math.min(1, v)));
      const left = Math.floor(x0 * W), top = Math.floor(y0 * H);
      const width = Math.max(16, Math.floor((x1 - x0) * W)), height = Math.max(16, Math.floor((y1 - y0) * H));
      if (left + width > W || top + height > H) continue;
      const crop = await sharp(src).extract({ left, top, width, height }).resize(768, 768, { fit: "inside" }).jpeg({ quality: 90 }).toBuffer();
      details.push({ kind: d.kind, note: d.note, storage_path: await putFile(`creative/twins/${tid}/${p.handle}/detail-${ph.index}-${k}.jpg`, crop, "image/jpeg") });
    }
  await pool.query(
    `UPDATE creative_product_twins SET status = 'ready', facts = $3::jsonb, cutouts = $4::jsonb, details = $5::jsonb, updated_at = now() WHERE tenant_id = $1::uuid AND product_id = $2`,
    [tid, productId, JSON.stringify(facts), JSON.stringify(cutouts), JSON.stringify(details)],
  );
  return { status: "done", progress: `Ready: ${cutouts.length} cut-outs, ${details.length} detail crops — please check and confirm ✓` };
};

/** The owner's flat-lay / hanger photo replaces a cut-out. */
export async function replaceCutout(pool: Pool, tenantId: string, productId: string, angle: string, bytes: Buffer): Promise<void> {
  const t = await getTwin(pool, tenantId, productId);
  if (!t) throw new PlainError("Build the product twin first.");
  const png = await sharp(bytes).rotate().flatten({ background: "#ffffff" }).resize(1024, 1536, { fit: "contain", background: "#ffffff" }).png().toBuffer();
  const path = await putFile(`creative/twins/${tenantId}/${t.handle || "p"}/upload-${angle}-${Date.now()}.png`, png, "image/png");
  const cut = (t.cutouts ?? []).filter((c: { angle: string }) => c.angle !== angle);
  cut.push({ angle, storage_path: path, from: "owner upload" });
  await pool.query(`UPDATE creative_product_twins SET cutouts = $3::jsonb, status = CASE WHEN status = 'no_images' THEN 'ready' ELSE status END, updated_at = now() WHERE tenant_id = $1::uuid AND product_id = $2`, [tenantId, productId, JSON.stringify(cut)]);
}

/** Cut-out bytes for the try-on (front first). */
export async function twinRefs(pool: Pool, tenantId: string, productIds: string[]): Promise<{ productId: string; title: string; angle: string; bytes: Buffer }[]> {
  const out: { productId: string; title: string; angle: string; bytes: Buffer }[] = [];
  for (const id of productIds) {
    const t = await getTwin(pool, tenantId, id);
    if (!t) continue;
    const order = ["front", "back", "detail", "side", "other"];
    for (const c of [...(t.cutouts ?? [])].sort((a: { angle: string }, b: { angle: string }) => order.indexOf(a.angle) - order.indexOf(b.angle)).slice(0, 3))
      out.push({ productId: id, title: t.title, angle: c.angle, bytes: (await getFile(c.storage_path)).bytes });
  }
  return out;
}
