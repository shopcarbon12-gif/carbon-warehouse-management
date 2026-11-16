/**
 * CarbonWMS Creative — "put the real product in" (owner, 2026-11-15: the Off Sneakers came back 8.4–8.8 every time,
 * always on small product details: the black toe point, 7 sole stripes, the logo size).
 *
 * A good picture whose ONLY problem is the product gets a close-up product pass instead of a full redraw:
 *   1. the vision model finds where the product is in the picture (box);
 *   2. that area is cut out square and enlarged to 1024 px, so the picture model has 3–4× the pixels for the details;
 *   3. the picture model redraws ONLY the product in that crop from the real product photos (same hands, angle, light);
 *   4. the crop is put back with soft edges, and the whole picture goes through the same 9.5 check again.
 *
 * Also: each product's SIGNATURE details (written once from its real photos) and the shot's colourway, used by every
 * picture prompt and by the check.
 */
import type { Pool } from "pg";
import sharp from "sharp";
import { z } from "zod";
import { json } from "./llm";
import { getTwin, twinRefs } from "./twin";
import type { CriticReport } from "./critic";
import type { Shot } from "./director";

export type Box = [number, number, number, number]; // left, top, width, height in pixels

/** Fails a product pass can fix: the product itself (and artifacts, which are mostly the hands on it). */
export function fixable(c: CriticReport | null | undefined): boolean {
  if (!c || !c.fails.length) return false;
  return c.fails.includes("garment_accuracy") && c.fails.every((f) => f === "garment_accuracy" || f === "ai_artifacts") && c.overall >= 8;
}

const Found = z.object({ boxes: z.array(z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })).max(4) });

/** Where the product is (one square box around every instance), or null if it fills too much of the picture to gain detail. */
export async function locateProduct(pool: Pool, tenantId: string, picture: Buffer, product: string, projectId: string): Promise<Box | null> {
  const meta = await sharp(picture).metadata();
  const W = meta.width ?? 1024;
  const H = meta.height ?? 1536;
  const small = await sharp(picture).resize(768, 768, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  const r = await json(
    pool,
    `Find every ${product} in this photo (worn or held). Reply with tight boxes as fractions of the image (x, y = top-left corner, w, h = size; all 0–1). Only the product itself, not the person.`,
    Found,
    { tenantId, what: "find the product in a picture", projectId, images: [{ b64: small.toString("base64") }], maxOutputTokens: 1500 },
  ).catch(() => null);
  const b = r?.value.boxes.filter((x) => x.w > 0.01 && x.h > 0.01) ?? [];
  if (!b.length) return null;
  const x0 = Math.max(0, Math.min(...b.map((x) => x.x)));
  const y0 = Math.max(0, Math.min(...b.map((x) => x.y)));
  const x1 = Math.min(1, Math.max(...b.map((x) => x.x + x.w)));
  const y1 = Math.min(1, Math.max(...b.map((x) => x.y + x.h)));
  // Square, with 18% room around it (context for the redraw), at least 340 px; inside the picture.
  let side = Math.max((x1 - x0) * W, (y1 - y0) * H) * 1.36;
  side = Math.max(340, Math.min(side, W, H));
  if ((side * side) / (W * H) > 0.6) return null; // the product fills the frame: a crop gains nothing
  const cx = ((x0 + x1) / 2) * W;
  const cy = ((y0 + y1) / 2) * H;
  const left = Math.round(Math.max(0, Math.min(W - side, cx - side / 2)));
  const top = Math.round(Math.max(0, Math.min(H - side, cy - side / 2)));
  return [left, top, Math.round(side), Math.round(side)];
}

/** The product area, enlarged to 1024×1024 for the redraw. */
export async function cropFor(picture: Buffer, box: Box): Promise<Buffer> {
  const [left, top, width, height] = box;
  return sharp(picture).extract({ left, top, width, height }).resize(1024, 1024).png().toBuffer();
}

/** The redrawn crop back into the picture with soft edges (no visible seam). */
export async function pasteBack(picture: Buffer, fixed: Buffer, box: Box): Promise<Buffer> {
  const [left, top, width, height] = box;
  const feather = Math.max(12, Math.round(width * 0.07));
  const piece = await sharp(fixed).resize(width, height).removeAlpha().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><filter id="f"><feGaussianBlur stdDeviation="${feather / 2.5}"/></filter></defs><rect width="100%" height="100%" fill="black"/><rect x="${feather}" y="${feather}" width="${width - 2 * feather}" height="${height - 2 * feather}" fill="white" filter="url(#f)"/></svg>`;
  const mask = await sharp(Buffer.from(svg)).resize(width, height).extractChannel(0).toBuffer();
  const overlay = await sharp(piece).joinChannel(mask).png().toBuffer();
  return sharp(picture).composite([{ input: overlay, left, top }]).png().toBuffer();
}

export function fixPrompt(product: string, signature: string, colourway: string | null): string {
  return [
    `The FIRST image is a close crop of a photo. Redraw ONLY the ${product} in it so it is EXACTLY the real CARBON product shown in the other images.`,
    signature ? `SIGNATURE DETAILS (must be exact): ${signature}` : "",
    colourway ? `Colourway: ${colourway} — only that one.` : "",
    "Keep EVERYTHING else exactly as it is in the first image: the hands and fingers, how the product is held or worn, its position, size, angle and perspective, the lace layout, the light, shadows, reflections, grain and background. Do not zoom, move, crop or reframe. Photoreal, no added text.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The real product photos for the product pass (no cut-outs of the person, no people). */
export async function productPhotos(pool: Pool, tenantId: string, products: string[]) {
  return (await twinRefs(pool, tenantId, products, { max: 8 }).catch(() => [])).map((g, i) => ({ name: `product-${i}-${g.angle.replace(/[^a-z]/gi, "")}.png`, bytes: g.bytes, mime: "image/png" }));
}

/* ------------------------------------------------------------------ signature details + colourway */

const Sig = z.object({ signature: z.string().max(600) });

/**
 * The few details that make the product THIS product, written once from its real photos (placement, count, colour) and
 * kept on the twin: "sole wall: heel half white with 7 black diagonal stripes, front half solid black; the black
 * rises to a small pointed tip on the toe…". The shop description can be loose; this is what the pictures follow.
 */
export async function productSignature(pool: Pool, tenantId: string, productId: string, projectId?: string | null): Promise<string> {
  const t = await getTwin(pool, tenantId, productId);
  if (!t) return "";
  const facts = (t.facts ?? {}) as { signature?: string };
  if (facts.signature) return facts.signature;
  const refs = await twinRefs(pool, tenantId, [productId], { max: 8 }).catch(() => []);
  if (!refs.length) return "";
  const imgs = await Promise.all(refs.map(async (g) => ({ b64: (await sharp(g.bytes).resize(768, 768, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer()).toString("base64") })));
  const r = await json(
    pool,
    [
      `These are real photos of one product: ${t.title}. Write its SIGNATURE details — the 4–7 things an illustrator would get wrong — so precisely that a drawing can match them exactly.`,
      "For each: WHERE it is (which part, which half, front/back/side), HOW MANY (count stripes, eyelets, buttons, rivets), its SHAPE and SIZE relative to the piece, its COLOUR, and what is NOT there (e.g. 'the upper is plain — no stripes on the upper').",
      "Logo: where, how big relative to the piece, its colour. If the product comes in several colours, say what changes between them and what stays the same.",
      "Only what you can SEE in these photos. One compact paragraph, no marketing words.",
    ].join("\n"),
    Sig,
    { tenantId, what: "product signature details", projectId: projectId ?? undefined, images: imgs, maxOutputTokens: 2500 },
  ).catch(() => null);
  const sig = r?.value.signature?.trim() ?? "";
  if (sig) await pool.query(`UPDATE creative_product_twins SET facts = jsonb_set(COALESCE(facts, '{}'::jsonb), '{signature}', to_jsonb($3::text)) WHERE tenant_id = $1::uuid AND product_id = $2`, [tenantId, productId, sig]);
  return sig;
}

/**
 * The colourway a shot shows: the one the shot names; else the one the rest of the creative names most (2026-11-15: the
 * anchor shot named no colour and came back BLACK while every other shot was WHITE); else null.
 */
export function shotColourway(colors: string[], shot: Shot, all: Shot[]): string | null {
  if (!colors.length) return null;
  const text = (s: Shot) => `${s.still_prompt ?? ""} ${s.subject_action ?? ""} ${s.garment_must_show ?? ""}`.toLowerCase();
  const named = (s: Shot) => colors.filter((c) => new RegExp(`\\b${c.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "")}\\b`).test(text(s)));
  const own = named(shot);
  if (own.length === 1) return own[0];
  if (own.length > 1) return null; // the shot shows several on purpose (e.g. one pair worn, one held)
  const count = new Map<string, number>();
  for (const s of all) for (const c of named(s)) count.set(c, (count.get(c) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return top?.[0] ?? null;
}
