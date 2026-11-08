/**
 * CarbonWMS Email — AI Designer (owner, 2026-11-07; reworked 2026-11-08).
 *
 * A chat per design. Every owner message ("make the hero bigger", "use these
 * photos", spoken or typed) becomes an AI turn that answers in words and DRAWS
 * the whole email as pictures, at the size a customer sees it:
 *   desktop — 1200 px wide = the 600 px email column at 2×;
 *   phone   — 1120 px wide = a 375 px phone at ~3×, drawn as a top part and a
 *             bottom part and joined (the picture model allows at most 3:1).
 * The owner chooses what a message changes (both views, desktop or mobile),
 * Batch (half price) or Fast, can attach photos and speak. "Convert to email"
 * (convert.ts) then turns the chosen pictures into real email code.
 *
 * One turn — the six-step process (owner, 2026-11-08):
 *  1. CONCEPT (creative.ts, the creative-director model chosen in Settings,
 *     GPT-6 Astra by default): the editorial idea — one campaign hero, three
 *     looks with very different pictures, a simple offer, the showroom — and
 *     its products. No layout, no HTML.
 *     REVIEW (when "approve the items first" is on): the turn stops at
 *     'review'; the owner removes, swaps or adds items and approves; changed
 *     items → the concept is rewritten around exactly those items.
 *  3. PHOTO ASSETS (assets.ts): the hero and the three look photos, drawn
 *     once per concept at full size and checked against the real products.
 *  2. COMPS: the designer (gpt-5.5) writes one brief per picture following
 *     the concept; the picture model draws desktop, phone top, phone bottom;
 *     every photo (logo, real photos, the four campaign photos) is a colour
 *     box that CarbonWMS fills with the original file (slots.ts) — no person
 *     or product is ever redrawn inside a comp.
 *  4–6. "Convert to email" (convert.ts) writes the HTML, renders it, has the
 *     creative model review the screenshots, fixes and re-checks.
 *
 * "Show me 3 directions": three turns from one message, each a new layout in a
 * different direction, sharing one set of items (picked/approved once). Picking
 * one is optional: the chat continues from the picked one, else direction 1.
 *
 * Versions made 2026-11-08 by the layout engine (layout.ts) still show and
 * convert; new turns are drawn pictures again (owner's choice).
 *
 * The worker's email tick (every minute) moves turns forward; nothing here
 * runs in the owner's browser, so leaving the page does not stop it.
 */
import sharp from "sharp";
import OpenAI, { toFile } from "openai";
import type { Pool } from "pg";
import { downloadStorageObject, uploadBytesToStorage } from "@/lib/storageProvider";
import { DESKTOP_SIZE, MOBILE_SIZE, getEmailSettings, imageModel, openai, textModel, transcribeModel } from "./config";
import { readFile } from "node:fs/promises";
import nodePath from "node:path";
import { LOGO_URLS, catalogLines, catalogSets, inStockCatalog, referencePhoto, type CatalogProduct, type CatalogSet } from "./catalog";
import { STORE_MEDIA, STORE_TEXT, mediaLibrary, mediaLines, type MediaItem, type TurnMedia } from "./brand";
import { styleGuide, styleText } from "./style";
import { BOX_RULES, SLOT_COLORS, TOKEN, briefWithBoxes, findBoxes, pasteReal, slotKeysIn, type Slot } from "./slots";
import { CONCEPT_RULES, cleanConcept, conceptText, creativeJson, img, txt, type Concept } from "./creative";
import { collectShots, drawShotsFast, finishShot, shotInputs, shotsFor, type Shot, type ShotStage } from "./assets";
import { freshStyles, styleBrief, styleName, STRUCTURES, type Style } from "./styles";
import { collectBanners, drawBannersFast, planLayout, renderLayout, submitBanners, type Banner, type LayoutStage, type LayoutTurn } from "./layout";

/** A product in a version; pieces of a matching set carry the set (shown as one card). */
export type TurnProduct = { id: string; title: string; url: string; price: number; image: string | null; set?: { name: string; line: string; total: number } | null };

export type View = "desktop" | "mobile";
export type Target = "both" | View;
type Step = "desktop" | "mobile-top" | "mobile-bottom";

type Msg = {
  id: string;
  design_id: string;
  role: "owner" | "ai";
  text: string;
  attachments: { path: string; name: string }[];
  target: Target;
  mode: "batch" | "fast" | null;
  status: string;
  desktop_prompt: string | null;
  mobile_prompt: string | null;
  desktop_path: string | null;
  mobile_path: string | null;
  mobile_top_path: string | null;
  batch_id: string | null;
  batch_files: Stage | null;
  error: string | null;
  products: TurnProduct[] | null;
  media: TurnMedia[] | null;
  engine: "picture" | "layout";
  variant_group: string | null;
  variant_no: number | null;
  picked: boolean | null;
  direction: string | null;
  html: string | null;
  banners: Banner[] | null;
  fresh: boolean | null;
  needs_review: boolean | null;
  /** The picture being drawn now (desktop | mobile-top | mobile-bottom | shots); the column is still called concept. */
  concept: string | null;
  /** Step 1 output (column concept_json would be clearer; kept in "concept_data"). */
  concept_data: Concept | null;
  shots: Shot[] | null;
  creative_model: string | null;
  image_model: string | null;
  style: Style | null;
  created_at: Date;
};

/** Where a turn's pictures are: which step is being drawn and which OpenAI files to clean up. */
type Stage =
  | { view: Step; batchId?: string; inputFileId?: string; refFileIds?: string[] }
  | ShotStage
  /** Everything of a message in ONE batch (photos + every picture of every direction), on direction 1 / the single turn. */
  | { view: "all"; batchId: string; inputFileId: string; refFileIds: string[]; turnIds: string[] }
  /** A direction whose pictures are in another turn's "all" batch. */
  | { view: "member"; lead: string; batchId?: undefined };

export const SAMPLE_NAME = "Maria";
export const SAMPLE_CODE = "CB20-K7Q4XM";
const MAX_PRODUCTS = 24;
const MAX_MEDIA = 4;
/** The picture model takes at most 16 input images. */
const MAX_REFS = 16;
const BOTTOM_MARK = "\n[[PHONE BOTTOM PART]]\n";
/** Turn states that are not finished ('approved-planning' = approved, being re-planned / drawn). */
const OPEN = ["queued", "planning", "generating", "review", "approved", "approved-planning"];

/** The version a group of three directions continues from: the picked one, else direction 1. */
const CHOSEN = `(m.variant_group IS NULL OR m.picked IS TRUE OR (m.variant_no = 1 AND NOT EXISTS (SELECT 1 FROM email_design_messages x WHERE x.variant_group = m.variant_group AND x.picked IS TRUE)))`;

const BRAND = `CARBON is a fashion retailer in Orlando, Florida (store + shopcarbon.com): trendy streetwear and going-out looks for men and women.
The logo is the official CARBON logo (a hexagon-cell mark followed by the word CARBON in a thin geometric sans-serif, wide letter-spacing). It is always given as a reference picture: reproduce exactly that logo, never redraw it in another font or style.
Never mention other brands, never invent prices, discounts or dates the owner did not give, never write "Carbon Jeans".
${STORE_TEXT}`;

const SCALE_RULES: Record<Step, string> = {
  desktop: `SIZE: the picture is the email at exactly 2× — its full 1200-pixel width is the 600-pixel email column, edge to edge (no margin, no background around it). Use real email sizes doubled: body text 15–16 px (30–32 picture px), small print 12–13 px (24–26), headings 26–48 px (52–96), buttons 44–52 px tall (88–104) and at least 200 px wide. The picture shows the email from its very top down to its end, about 1,790 email pixels tall: nothing may be cut off; if a section does not fit, leave it out.`,
  "mobile-top": `SIZE: the picture is a PHONE screen at 3× — its full 1120-pixel width is a 375-pixel phone, edge to edge (no phone frame, no status bar, no app chrome). Use real phone sizes tripled: body text 16 px (48 picture px), small print 13 px (39), headings 26–36 px (78–108), full-width buttons 48–52 px tall (144–156). This picture is the TOP PART of the phone email: from its very top down about 1,115 phone pixels; it must END at a clean break between two sections (never cut through text, a button or a product card).`,
  "mobile-bottom": `SIZE: the picture is a PHONE screen at 3× — its full 1120-pixel width is a 375-pixel phone, edge to edge (no phone frame, no status bar, no app chrome). Same text sizes as the top part (body 16 px = 48 picture px). This picture is the BOTTOM PART of the phone email: it continues EXACTLY where the top part (image 1) ends — same width, margins, colours, fonts and style — and runs to the end of the email. Do not repeat anything from the top part; any empty space at the very bottom is plain background.`,
};

const COMMON_RULES = `Typography must be crisp and perfectly spelled, exactly the words given. Personal parts use sample values: the customer's first name is "${SAMPLE_NAME}" and a personal discount code (when there is one) is "${SAMPLE_CODE}" shown in a clearly separate box. Buttons are solid rectangles with their label inside. Leave out any unsubscribe line, legal footer or postal address (added automatically later). Nothing may be cut off at the edges.
REAL PICTURES ARE PASTED IN LATER: the CARBON logo, product photos, store photos, CARBON pictures and attached photos appear ONLY as the placeholder boxes the brief gives. Never draw them yourself, and never draw a CARBON logo, hexagon mark or wordmark anywhere else.
GENERATED PHOTOS (banners, lifestyle shots) are REALISTIC, APPROACHABLE STREETWEAR photography, not glossy fashion editorial: everyday-looking people (new faces every time, never the face of anyone in a reference photo), real skin with texture, real hands, relaxed candid poses and expressions; real Orlando places in daylight or golden hour — sidewalks, street corners, crosswalks, parking lots, storefronts, basketball courts, outdoor stairs, palm-lined streets; shot like a 35mm film camera or a good phone: natural light, slight grain, true colours, a little imperfect. NEVER: luxury hotel lobbies, marble, gold doors, chandeliers, red carpets, glossy wet night streets, HDR, CGI or plastic-looking skin, runway poses.
CLOTHES on generated people: exactly the real products in the reference photos — same type, cut, colour, wash, prints, stitching, hardware and any CARBON lettering; where a side is not visible in the photos, keep it plain. NEVER add another brand's logo, swoosh, stripes, monogram or wordmark to anything.`;

/** Page structures for 3 directions (each direction gets a different one, so layouts really differ). */
export const SKELETONS = [
  "HERO + THREE LOOKS: one full-width lifestyle banner on top, the headline in clean type under it; then three outfit rows — a lifestyle photo on one side, its 2–4 product tiles with names and prices on the other, alternating sides; a slim offer strip; the store last.",
  "MOSAIC, NO HERO PHOTO: open with the headline in big type on a solid colour block; then an asymmetric grid where product tiles and two lifestyle photos of different sizes interlock (one large + two small, then two + one); the offer as a tag inside the grid; the store as a compact card.",
  "STORY SCROLL: a vertical run of 4–5 full-width tall lifestyle photos like phone stories, each with one short line of copy and a small row of the products worn in it right beneath; the offer as its own story; the store photo as the final story with directions.",
  "THE LETTER: opens with a short personal note in plain type (no photo) from the Orlando store, then ONE large outfit photo, then a tidy two-column product grid with prices, then the store.",
  "PRICE LIST: a printed-catalogue look — numbered rows (01, 02 …) each with a small product tile, name and price in a menu layout, one wide street photo as a divider halfway, the store at the end.",
  "SPLIT SCREEN: every section is two equal halves side by side (photo | text, text | photo, tile | tile), dark and light halves alternating like a checkerboard down the email.",
];

/** A logo file (transparent PNG) to paste. */
async function logoFile(color: "black" | "white"): Promise<Buffer> {
  try {
    return await readFile(nodePath.join(process.cwd(), `public/email/carbon-logo-long-${color}.png`));
  } catch {
    const r = await fetch(color === "black" ? LOGO_URLS.longBlack : LOGO_URLS.longWhite, { signal: AbortSignal.timeout(15_000) });
    return Buffer.from(await r.arrayBuffer());
  }
}

function sizeOf(step: Step) {
  return step === "desktop" ? DESKTOP_SIZE : MOBILE_SIZE;
}

export function pictureFrame(step: Step, brief: string, lead: string, style: string): string {
  return [lead, SCALE_RULES[step], COMMON_RULES, `Brand: ${BRAND}`, style, `What this picture must show:\n${brief}`].filter(Boolean).join("\n\n");
}

/* ------------------------------------------------------------------ queries */

export async function listMessages(pool: Pool, designId: string): Promise<Msg[]> {
  const r = await pool.query<Msg>(`SELECT * FROM email_design_messages WHERE design_id = $1::uuid ORDER BY created_at, role DESC`, [designId]);
  return r.rows;
}

type BaseRow = { id: string; desktop_path: string | null; mobile_path: string | null; products: TurnProduct[] | null; media: TurnMedia[] | null; direction: string | null };

/** The version a new turn builds on (newest finished one; for 3 directions the picked one, else direction 1). */
async function baseVersion(pool: Pool, designId: string, before?: Date): Promise<BaseRow | null> {
  const r = await pool.query<BaseRow>(
    `SELECT m.id::text, m.desktop_path, m.mobile_path, m.products, m.media, m.direction FROM email_design_messages m
      WHERE m.design_id = $1::uuid AND m.role = 'ai' AND m.status = 'done' AND ($2::timestamptz IS NULL OR m.created_at < $2) AND ${CHOSEN}
      ORDER BY m.created_at DESC LIMIT 1`,
    [designId, before ?? null],
  );
  return r.rows[0] ?? null;
}

/** Owner message + the AI turn(s) that answer it. */
export async function addOwnerMessage(
  pool: Pool,
  input: { designId: string; text: string; attachments: { path: string; name: string }[]; target: Target; mode: "batch" | "fast"; by: string | null; directions?: boolean; review?: boolean },
): Promise<{ ownerId: string; aiId: string; aiIds: string[] }> {
  const busy = await pool.query<{ status: string }>(`SELECT status FROM email_design_messages WHERE design_id = $1::uuid AND status = ANY($2::text[]) LIMIT 1`, [input.designId, OPEN]);
  if (busy.rows[0]?.status === "review") throw new Error("The AI is waiting for you to approve its items (above). Approve them, or stop it, before sending another message.");
  if (busy.rowCount) throw new Error("The AI is still working on the last message. Wait for it to finish (or stop it) before sending another.");
  const base = await baseVersion(pool, input.designId);
  // The first turn and new directions always make both views.
  const target: Target = !base?.desktop_path || !base.mobile_path || input.directions ? "both" : input.target;
  const o = await pool.query<{ id: string }>(
    `INSERT INTO email_design_messages (design_id, role, text, attachments, target, status, created_by) VALUES ($1::uuid, 'owner', $2, $3, $4, 'done', $5) RETURNING id`,
    [input.designId, input.text, JSON.stringify(input.attachments), target, input.by],
  );
  const n = input.directions ? 3 : 1;
  const group = input.directions ? crypto.randomUUID() : null;
  const aiIds: string[] = [];
  // A fresh style for every version (structure × type × colours), never one the store's recent emails used.
  const tenant = await pool.query<{ tenant_id: string }>(`SELECT tenant_id::text FROM email_designs WHERE id = $1::uuid`, [input.designId]);
  const styles = await freshStyles(pool, tenant.rows[0]?.tenant_id ?? "", input.designId, n);
  for (let i = 1; i <= n; i++) {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO email_design_messages (design_id, role, target, mode, status, engine, variant_group, variant_no, fresh, needs_review, style, created_at)
       VALUES ($1::uuid, 'ai', $2, $3, 'queued', 'picture', $4::uuid, $5, $6, $7, $9, now() + ($8 || ' milliseconds')::interval) RETURNING id`,
      [input.designId, target, input.mode, group, group ? i : null, group ? true : null, input.review !== false, String(i), JSON.stringify(styles[i - 1])],
    );
    aiIds.push(a.rows[0].id);
  }
  await pool.query(`UPDATE email_designs SET updated_at = now(), status = CASE WHEN status = 'failed' THEN 'drafting' ELSE status END WHERE id = $1::uuid`, [input.designId]);
  return { ownerId: o.rows[0].id, aiId: aiIds[0], aiIds };
}

/** Stop a turn that is still waiting / being drawn (or waiting for the owner's approval). */
export async function stopTurn(pool: Pool, designId: string): Promise<boolean> {
  const r = await pool.query<{ batch_files: Stage | LayoutStage | null }>(
    `UPDATE email_design_messages SET status = 'failed', error = 'Stopped', finished_at = now()
      WHERE design_id = $1::uuid AND status = ANY($2::text[]) RETURNING batch_files`,
    [designId, OPEN],
  );
  for (const row of r.rows) {
    if (row.batch_files?.batchId) await openai().batches.cancel(row.batch_files.batchId).catch(() => {});
  }
  return (r.rowCount ?? 0) > 0;
}

/** The owner continues from one of the 3 directions (optional; direction 1 otherwise). */
export async function pickDirection(pool: Pool, designId: string, messageId: string): Promise<void> {
  const r = await pool.query<{ variant_group: string | null }>(
    `SELECT variant_group::text FROM email_design_messages WHERE id = $1::uuid AND design_id = $2::uuid AND role = 'ai' AND status = 'done'`,
    [messageId, designId],
  );
  const g = r.rows[0]?.variant_group;
  if (!g) throw new Error("That version is not one of three directions");
  await pool.query(`UPDATE email_design_messages SET picked = (id = $2::uuid) WHERE variant_group = $1::uuid`, [g, messageId]);
  await pool.query(`UPDATE email_designs SET updated_at = now() WHERE id = $1::uuid`, [designId]);
}

/* ------------------------------------------------------------------ products */

/** Catalog products (and set refs) → the version's products; a set brings all its pieces, tagged with the set. */
function turnProducts(refsOrIds: string[], catalog: CatalogProduct[], sets: CatalogSet[]): TurnProduct[] {
  const setOf = new Map<string, CatalogSet>();
  for (const s of sets) for (const p of s.pieces) setOf.set(p.id, s);
  const out: TurnProduct[] = [];
  const add = (p: CatalogProduct) => {
    if (out.some((x) => x.id === p.id) || out.length >= MAX_PRODUCTS) return;
    const s = setOf.get(p.id);
    out.push({ id: p.id, title: p.title, url: p.url, price: p.price, image: p.image, set: s ? { name: s.name, line: s.piecesLine, total: s.total } : null });
  };
  for (const raw of refsOrIds) {
    const r = String(raw).trim();
    const set = sets.find((s) => s.ref === r.toUpperCase());
    if (set) {
      set.pieces.forEach(add);
      continue;
    }
    const p = catalog.find((c) => c.ref === r.toUpperCase() || c.id === r);
    if (!p) continue;
    // A piece of a set always comes with the rest of its set (shown as one card).
    const s = setOf.get(p.id);
    if (s) s.pieces.forEach(add);
    else add(p);
  }
  return out;
}

/* ------------------------------------------------------------------ planning */

async function asDataUrl(path: string, maxW = 900): Promise<string> {
  const obj = await downloadStorageObject(path);
  const jpg = await sharp(Buffer.from(obj.body)).rotate().resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

type Plan = {
  reply: string;
  title: string | null;
  subject: string | null;
  preheader: string | null;
  direction: string | null;
  fresh: boolean;
  desktop_prompt: string | null;
  mobile_prompt: string | null;
  products: TurnProduct[];
  media: TurnMedia[];
};

function planSystem(style: string): string {
  return `You are the creative director and email designer inside CarbonWMS, working for the owner of CARBON, an Orlando streetwear store.
${BRAND}

${style}
PHOTO STYLE FOR ANY GENERATED PICTURE (this overrides the campaign look): realistic, approachable streetwear photography — everyday-looking new people (never a known face), real Orlando streets in daylight or golden hour, candid and relaxed, 35mm-film / phone look. Never luxury lobbies, marble, gold, glossy night streets or glamour poses.

The owner describes an email (or changes to it) in a chat. Each version is DRAWN as pictures at the real size a customer sees: a DESKTOP picture (the 600 px email column, about 1,790 px tall) and a PHONE picture (375 px wide) made of a TOP part and a BOTTOM part (each about 1,115 phone px tall). The owner's message says which view(s) to change: "both", "desktop" or "mobile".

YOU ARE THE DESIGNER: the creative director already wrote the CONCEPT (given below) — design it. Never change its story, its words' meaning, its photos or its items; your job is the page: structure, rhythm, type, colour, spacing.
EVERY PICTURE IS PASTED IN, NOT DRAWN. In your briefs never describe what a picture looks like; mark its spot with a token and give the spot's size and shape:
  [[LOGO]] the official CARBON logo (exactly once per picture, where the logo goes; never ask for a logo anywhere else)
  [[PHOTO:H1]] the concept's campaign hero photo (landscape 3:2 — its box between 16:9 and 4:3)
  [[PHOTO:L1]] [[PHOTO:L2]] [[PHOTO:L3]] the photo of look 1 / 2 / 3 (portrait 2:3 — its box portrait, 2:3 or 4:5; never landscape)
  [[PHOTO:P12]] a product's original catalog photo (a product tile, portrait 4:5) · [[PHOTO:X3]] a matching set's photo
  [[PHOTO:S1]] / [[PHOTO:S2]] the real store photos (outside / inside, landscape 4:3) · [[PHOTO:A1]] a photo the owner attached
e.g. "a product tile: [[PHOTO:P12]] portrait 4:5, 130 px wide, its name and price under it". At most 11 photo tokens per picture (each needs its own colour). There are no other photos: never ask the picture model to draw people, clothes or places.

Write JSON with:
- reply: 1–3 short plain sentences to the owner about what you chose / are drawing (no em dashes, no hype). If something is impossible or unclear, say so and make your best version anyway.
- title: a 2–5 word name for this email (first turn only, otherwise null).
- subject: subject line (max 60 characters, may use {{first_name}}), or null to keep the previous one.
- preheader: inbox preview text (max 90 characters), or null to keep it.
- direction: the creative direction of this version in under 12 words.
- layout: "new" or "edit". "new" when there is no version yet, or the owner asks for a different / more creative / new layout or look: then build a DIFFERENT PAGE STRUCTURE from every earlier direction listed (not the same sections with new colours). "edit" for changes to the current version: change what was asked and carry over everything else exactly.
- desktop_prompt: when the desktop view changes, a complete, self-contained brief of the WHOLE desktop email from top to bottom: every section in order, the exact words of every heading, paragraph, price and button, every real-picture token with its size and shape, every generated photo in words, colours, type style, alignment, spacing, sizes in EMAIL pixels. Never write "same as before". Null when the desktop does not change.
- mobile_top / mobile_bottom: when the phone view changes, the same for the phone layout (stacked blocks, full-width buttons), split into the TOP part (from the top to a clean section break about 1,115 phone px down) and the BOTTOM part (the rest, to the end). Both null when the phone view does not change.
- products / media: return null (the concept fixed them).

CREATIVE RULES:
- Show every look with its photo (L1–L3) and its pieces as tiles or a list with names and prices; the hero H1 big and early; the offer simple; the showroom with the store photo and facts.
- Make the layout earn attention with real structure, rhythm and big/small contrast — not the same logo / big photo / product grid / black code panel every time.
- When the owner asks for MORE items, ADD them to what is there (never swap the existing ones out unless asked).
- Product names and prices shown must be exactly the catalog's.
- MATCHING SETS (X-refs, listed after the catalog) are ONE card like the store's homepage: the set photo token [[PHOTO:X3]] with a small black label in its top-left corner, white bold uppercase letter-spaced "2-PIECE SET" (or "3-PIECE SET"); a tiny grey uppercase "CARBON"; the set name in bold uppercase ("COLE SET"); the pieces line in small grey text exactly as given ("Top $67.00 + Pants $65.00"); the total in bold, "Set $132.00". Never as separate pieces with separate prices.
- When the email mentions the store, a visit, hours or directions, use the exact store facts and the store photo tokens; "Get directions" goes to Google Maps.
- Personal parts: the customer's first name appears as "${SAMPLE_NAME}", a personal code as "${SAMPLE_CODE}". No unsubscribe line or postal address (added automatically).

Page structures (a "new" layout normally gets one assigned — use it):
${Object.values(STRUCTURES).map((d, i) => `${i + 1}. ${d}`).join("\n")}`;
}

async function tenantOf(pool: Pool, designId: string): Promise<string> {
  const r = await pool.query<{ tenant_id: string }>(`SELECT tenant_id::text FROM email_designs WHERE id = $1::uuid`, [designId]);
  return r.rows[0]?.tenant_id ?? "";
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Plan a turn. `locked` = the owner approved exactly these items (or a direction
 * shares direction 1's items): the briefs must use them and nothing else.
 */
async function plan(pool: Pool, turn: Msg, locked: { products: TurnProduct[]; media: TurnMedia[] } | null): Promise<Plan> {
  locked = locked ?? (turn.concept_data ? { products: turn.products ?? [], media: turn.media ?? [] } : null);
  const history = await pool.query<{ role: string; text: string; target: string; attachments: { path: string; name: string }[]; direction: string | null }>(
    `SELECT m.role, m.text, m.target, m.attachments, m.direction FROM email_design_messages m
      WHERE m.design_id = $1::uuid AND m.created_at < $2 AND (m.role = 'owner' OR (m.status = 'done' AND ${CHOSEN})) ORDER BY m.created_at`,
    [turn.design_id, turn.created_at],
  );
  const base = await baseVersion(pool, turn.design_id, turn.created_at);
  const owner = history.rows.filter((h) => h.role === "owner").at(-1);
  const earlier = [...new Set(history.rows.map((h) => h.direction).filter((d): d is string => !!d))];
  const [catalog, library, style] = await Promise.all([
    inStockCatalog().catch((e) => {
      console.warn("[email-ai] catalog unavailable:", e instanceof Error ? e.message : e);
      return [] as CatalogProduct[];
    }),
    mediaLibrary(pool),
    styleGuide(pool, await tenantOf(pool, turn.design_id)),
  ]);
  const sets = catalogSets(catalog);
  const refOf = (id: string) => catalog.find((c) => c.id === id)?.ref;
  const mediaRef = (id: string) => library.find((m) => m.id === id)?.ref;

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  const vStyle = turn.style;
  const variant = turn.variant_no
    ? `\n\nTHIS IS DIRECTION ${turn.variant_no} OF 3 for the owner's last message: layout "new", in THIS style — follow all three parts, they are what makes the three directions different (the other two use completely different structures, type and colours):\n${vStyle ? styleBrief(vStyle) : SKELETONS[(hash(turn.variant_group ?? "") + turn.variant_no) % SKELETONS.length]}`
    : vStyle
      ? `\n\nTHE STYLE FOR THIS VERSION (the owner wants a different style every time): if this is a "new" layout — a new email, or the owner asks for a different / new / more creative look — build it in exactly this style, whatever earlier versions looked like:\n${styleBrief(vStyle)}\nIf the owner only asks for small changes to the current version ("edit"), keep the current style instead.`
      : "";
  content.push({
    type: "text",
    text:
      `Conversation so far:\n${history.rows.map((h) => (h.role === "owner" ? `OWNER (change: ${h.target})` : "YOU") + `: ${h.text}`).join("\n")}\n\n` +
      `This turn changes: ${turn.target}.` +
      (earlier.length ? `\nEarlier directions (a "new" layout must differ from all of them): ${earlier.join(" | ")}` : "") +
      variant +
      (base?.desktop_path || base?.mobile_path ? "\n\nThe current pictures follow (desktop first, then the phone)." : "\n\nThere is no design yet: this is the first version (layout \"new\"), describe both views."),
  });
  if (base?.desktop_path) content.push({ type: "image_url", image_url: { url: await asDataUrl(base.desktop_path), detail: "high" } });
  if (base?.mobile_path) content.push({ type: "image_url", image_url: { url: await asDataUrl(base.mobile_path, 700), detail: "high" } });

  if (turn.concept_data) {
    const name = (id: string) => {
      const set = sets.find((x) => x.pieces.some((q) => q.id === id));
      const p = catalog.find((x) => x.id === id) ?? (turn.products ?? []).find((x) => x.id === id);
      if (set) return `${set.ref} ${set.name} (${set.piecesLine}, Set $${set.total.toFixed(2)})`;
      const ref = catalog.find((x) => x.id === id)?.ref ?? "";
      return p ? `${ref} ${p.title} $${p.price.toFixed(2)}`.trim() : id;
    };
    content.push({ type: "text", text: `THE CONCEPT (from the creative director — design exactly this):\n${conceptText(turn.concept_data, name)}` });
  }
  if (locked && !turn.concept_data) {
    content.push({
      type: "text",
      text:
        (turn.variant_no
          ? `THE ITEM POOL IS FIXED (approved by the owner). Use only these; choose the 6–8 that suit your direction best (the three directions should feature different ones):\n`
          : `THE ITEMS ARE FIXED (approved by the owner). Use EXACTLY these, all of them where they fit (at most 8 tiles / sets per picture), and nothing else from the catalog:\n`) +
        locked.products.map((p) => `- ${refOf(p.id) ?? p.id} ${p.title} $${p.price.toFixed(2)}${p.set ? ` (piece of ${p.set.name}: ${p.set.line}, Set $${p.set.total.toFixed(2)})` : ""}`).join("\n") +
        (locked.media.length ? `\nCARBON pictures: ${locked.media.map((m) => `${mediaRef(m.id) ?? m.id} (${m.description})`).join("; ")}` : "\nNo CARBON pictures.") +
        `\nReturn the same refs in "products" and "media".`,
    });
  }
  content.push({
    type: "text",
    text: catalog.length
      ? `CATALOG (${catalog.length} products in stock) — ref | name | type | men/women | colours | price | stock:\n${catalogLines(catalog, sets)}\n\n` +
        (base?.products?.length ? `Products in the current version: ${base.products.map((p) => `${refOf(p.id) ?? "(no longer in stock)"} ${p.title}`).join(", ")}.` : "No products chosen yet.")
      : "The catalog could not be read right now: do not show specific products; use attached photos only.",
  });
  content.push({
    type: "text",
    text:
      `CARBON PICTURES — ref | kind | shape | description (S1/S2 are the real store photos):\n${mediaLines(library)}\n\n` +
      (base?.media?.length ? `CARBON pictures in the current version: ${base.media.map((m) => mediaRef(m.id) ?? "(removed)").join(", ")}.` : "No CARBON pictures chosen yet."),
  });
  for (const [i, a] of (owner?.attachments ?? []).entries()) {
    content.push({ type: "text", text: `Attached photo ${i + 1} (${a.name}):` });
    content.push({ type: "image_url", image_url: { url: await asDataUrl(a.path, 768), detail: "low" } });
  }
  const c = await openai().chat.completions.create({
    model: textModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: planSystem(styleText(style?.guide)) },
      { role: "user", content },
    ],
  });
  const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
  const want = (v: View) => turn.target === "both" || turn.target === v;
  const str = (v: unknown, n: number) => (v ? String(v).slice(0, n) : null);
  // Picture tokens: planner refs (P12, X3, M7 change with stock) → stable keys (p<id>, s1, m<id>, a1).
  const gid = (id: string) => id.split("/").pop() ?? id;
  const keyOf = (ref: string): string | null => {
    const r = ref.toUpperCase();
    if (r === "S1" || r === "S2") return r.toLowerCase();
    if (/^(H1|L[1-3])$/.test(r)) return r.toLowerCase();
    if (/^A\d+$/.test(r)) return r.toLowerCase();
    const set = sets.find((x) => x.ref === r);
    if (set) return `p${gid(set.lead.id)}`;
    const p = catalog.find((x) => x.ref === r);
    if (p) return `p${gid(p.id)}`;
    const m = library.find((x) => x.ref === r);
    if (m) return m.kind === "store" ? r.toLowerCase() : `m${gid(m.id)}`;
    return null;
  };
  const tokenRefs: string[] = [];
  const keyed = (t: string | null) =>
    t?.replace(TOKEN, (all, what: string, ref?: string) => {
      if (what.toUpperCase() === "LOGO") return "[[LOGO]]";
      const k = keyOf(ref ?? "");
      if (!k) return "";
      tokenRefs.push((ref ?? "").toUpperCase());
      return `[[PHOTO:${k}]]`;
    }) ?? null;
  const top = keyed(str(j.mobile_top, 8000));
  const bottom = keyed(str(j.mobile_bottom, 8000));
  const desktop = keyed(str(j.desktop_prompt, 8000));
  const listedRefs = Array.isArray(j.products) ? (j.products as unknown[]).map(String) : null;
  const shownRefs = tokenRefs.filter((r) => /^[PX]\d+$/.test(r));
  const products = locked
    ? locked.products
    : listedRefs
      ? turnProducts([...listedRefs, ...shownRefs], catalog, sets)
      : [...(base?.products ?? []), ...turnProducts(shownRefs, catalog, sets).filter((p) => !(base?.products ?? []).some((b) => b.id === p.id))];
  const mediaRefs = [...(Array.isArray(j.media) ? (j.media as unknown[]).map((r) => String(r).trim().toUpperCase()) : []), ...tokenRefs.filter((r) => /^[SM]\d+$/.test(r))];
  const media = locked
    ? locked.media
    : mediaRefs.length || Array.isArray(j.media)
      ? [...new Set(mediaRefs)]
          .map((r) => library.find((m) => m.ref === r))
          .filter((m): m is MediaItem => !!m)
          .slice(0, MAX_MEDIA)
          .map((m) => ({ id: m.id, url: m.url, width: m.width, height: m.height, kind: m.kind, description: m.description }))
      : (base?.media ?? []);
  return {
    reply: String(j.reply ?? "Here is the new version.").slice(0, 1200),
    title: str(j.title, 80),
    subject: str(j.subject, 120),
    preheader: str(j.preheader, 200),
    direction: str(j.direction, 160),
    fresh: !!turn.variant_no || j.layout === "new" || !base,
    desktop_prompt: want("desktop") ? (desktop ?? owner?.text ?? "") : null,
    mobile_prompt: want("mobile") ? `${top ?? desktop ?? owner?.text ?? ""}${BOTTOM_MARK}${bottom ?? "The rest of the email, continuing the top part, to the end."}` : null,
    products,
    media,
  };
}

/* ------------------------------------------------------------------ pictures */

type Inputs = { prompt: string; size: string; images: Buffer[] };

const load = async (p: string) => Buffer.from((await downloadStorageObject(p)).body);

/** The top or bottom half of a (joined) phone picture. */
async function half(path: string, which: "top" | "bottom"): Promise<Buffer> {
  const b = await load(path);
  const m = await sharp(b).metadata();
  const h = Math.floor((m.height ?? 2) / 2);
  return sharp(b).extract({ left: 0, top: which === "top" ? 0 : h, width: m.width ?? 1, height: h }).png().toBuffer();
}

/** What one picture (desktop, phone top or phone bottom) is drawn from. */
async function inputsFor(pool: Pool, turn: Msg, step: Step): Promise<Inputs> {
  const prev = await baseVersion(pool, turn.design_id, turn.created_at);
  const owner = await pool.query<{ attachments: { path: string; name: string }[] }>(
    `SELECT attachments FROM email_design_messages WHERE design_id = $1::uuid AND role = 'owner' AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
    [turn.design_id, turn.created_at],
  );
  const atts = (owner.rows[0]?.attachments ?? []).slice(0, 6);
  const fresh = !!turn.fresh;
  const images: Buffer[] = [];
  const labels: string[] = [];
  const desktopNow = turn.desktop_path ?? (turn.target === "mobile" ? (prev?.desktop_path ?? null) : null);
  let lead = "Make a CARBON marketing email design.";
  if (step === "desktop") {
    if (prev?.desktop_path && !fresh) {
      images.push(await load(prev.desktop_path));
      labels.push("the current desktop version (edit it)");
    } else if (prev?.desktop_path) lead = "Make a NEW CARBON marketing email design from a blank page (a new layout, not an edit of an earlier one).";
  } else if (step === "mobile-top") {
    if (desktopNow) {
      images.push(await load(desktopNow));
      labels.push("the finished DESKTOP version of this email");
      lead = "Make the PHONE version of the SAME email shown in the desktop picture: the same words, photos, colours, order of sections and style, re-laid-out for a narrow phone screen.";
    }
    if (prev?.mobile_path && !fresh) {
      images.push(await half(prev.mobile_path, "top"));
      labels.push(desktopNow ? "the previous phone version's top part (keep its layout choices unless the brief changes them)" : "the current phone version's top part (edit it)");
    }
  } else {
    if (turn.mobile_top_path) {
      images.push(await load(turn.mobile_top_path));
      labels.push("the TOP PART of this phone email, already finished: continue exactly below it");
      lead = "Draw the BOTTOM PART of the phone email whose top part is image 1.";
    } else {
      // Drawn at the same time as the top part: continue it from the brief alone.
      lead = "Draw the BOTTOM PART of a phone email. Its top part (drawn separately) ends exactly where this brief begins: start right at the first section described, with the same page background, margins, fonts and colours the brief gives, so the two parts join seamlessly.";
    }
    if (desktopNow) {
      images.push(await load(desktopNow));
      labels.push("the finished DESKTOP version of this email (the same content)");
    }
    if (prev?.mobile_path && !fresh) {
      images.push(await half(prev.mobile_path, "bottom"));
      labels.push("the previous phone version's bottom part (layout guide)");
    }
  }
  for (const [i, a] of atts.entries()) {
    if (images.length >= MAX_REFS - 2) break;
    images.push(await load(a.path));
    labels.push(`attached photo ${i + 1} (${a.name})`);
  }
  const style = await styleGuide(pool, await tenantOf(pool, turn.design_id));
  const brief = step === "desktop" ? (turn.desktop_prompt ?? "") : (turn.mobile_prompt ?? "").split(BOTTOM_MARK)[step === "mobile-top" ? 0 : 1] ?? "";
  const slots = turnSlots(turn);
  const legend = labels.length ? `\n\nThe input images, in order:\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}` : "";
  const styleLine = style?.guide ? `Campaign look (graphic design only — colours and type): palette ${style.guide.palette.join(", ")}. ${style.guide.typography}` : "";
  const boxes = BOX_RULES(slots.filter((x) => slotKeysIn(brief).includes(x.key)));
  return { prompt: [pictureFrame(step, briefWithBoxes(brief, slots), lead, styleLine), boxes].filter(Boolean).join("\n\n") + legend, size: sizeOf(step), images };
}

/** The real pictures of a turn, each with its own colour (the same colours in every picture of the turn). */
function turnSlots(turn: Msg): Slot[] {
  const gidOf = (id: string) => id.split("/").pop() ?? id;
  const out: Slot[] = [];
  for (const key of slotKeysIn(turn.desktop_prompt, turn.mobile_prompt)) {
    if (out.length >= SLOT_COLORS.length) break;
    const color = SLOT_COLORS[out.length];
    if (key === "logo") {
      out.push({ key, kind: "logo", label: "the CARBON logo (wide and short)", color });
      continue;
    }
    if (key === "s1" || key === "s2") {
      const st = STORE_MEDIA[key === "s1" ? 0 : 1];
      out.push({ key, kind: "store", label: key === "s1" ? "the store photo (outside)" : "the store photo (inside)", color, url: st.url });
      continue;
    }
    if (key.startsWith("p")) {
      const p = (turn.products ?? []).find((x) => `p${gidOf(x.id)}` === key);
      if (p) out.push({ key, kind: "product", label: p.set ? `the photo of the ${p.set.name}` : `the photo of ${p.title}`, color, url: p.image });
      continue;
    }
    if (key.startsWith("m")) {
      const m = (turn.media ?? []).find((x) => `m${gidOf(x.id)}` === key);
      if (m) out.push({ key, kind: "brand", label: `a CARBON picture (${m.description.slice(0, 60)})`, color, url: m.url });
      continue;
    }
    if (/^a\d+$/.test(key)) out.push({ key, kind: "attachment", label: `attached photo ${key.slice(1)}`, color, path: null });
    if (/^(h1|l[1-3])$/.test(key)) {
      const shot = (turn.shots ?? []).find((x) => x.id === key);
      if (shot?.path) out.push({ key, kind: "shot", label: key === "h1" ? "the campaign hero photo" : `the photo of look ${key.slice(1)}`, color, path: shot.path });
    }
  }
  return out;
}

/** Paste the original pictures into their boxes in a freshly drawn picture. */
/** The brief of one picture of a turn. */
function briefOf(turn: Msg, step: Step): string {
  return step === "desktop" ? (turn.desktop_prompt ?? "") : ((turn.mobile_prompt ?? "").split(BOTTOM_MARK)[step === "mobile-top" ? 0 : 1] ?? "");
}

/**
 * Paste the original pictures into their boxes in a freshly drawn picture. If the model drew some of
 * them itself instead of leaving the box (it sometimes draws a photo with a coloured line on one edge),
 * the picture goes back once as an EDIT: "cover these elements with solid boxes, change nothing else".
 */
async function withRealPictures(pool: Pool, turn: Msg, step: Step, png0: Buffer, log: (m: string) => void = console.log): Promise<Buffer> {
  const all = turnSlots(turn);
  const expected = new Set(slotKeysIn(briefOf(turn, step)));
  const slots = all.filter((x) => expected.has(x.key));
  if (!slots.length) return png0;
  let png = png0;
  const owner = await pool.query<{ attachments: { path: string; name: string }[] }>(
    `SELECT attachments FROM email_design_messages WHERE design_id = $1::uuid AND role = 'owner' AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
    [turn.design_id, turn.created_at],
  );
  const atts = owner.rows[0]?.attachments ?? [];
  const loader = async (s: Slot) => {
    if (s.kind === "attachment") {
      const a = atts[Number(s.key.slice(1)) - 1];
      return a ? load(a.path) : null;
    }
    if (s.kind === "shot") return s.path ? load(s.path) : null;
    return s.url ? referencePhoto(s.url, 1600) : null;
  };
  const logos = { black: () => logoFile("black"), white: () => logoFile("white") };
  const missingBoxes = async (pic: Buffer) => {
    const found = await findBoxes(pic, slots.map((x) => x.color));
    return slots.filter((x) => !(found.get(x.color.hex) ?? []).length);
  };
  const missing = await missingBoxes(png);
  if (missing.length) {
    log(`[email-ai] turn ${turn.id} ${step}: boxes not drawn for ${missing.map((x) => x.key).join(", ")} — repairing`);
    try {
      const prompt = [
        "Edit image 1, an email design. Cover each element listed below with ONE perfectly flat, solid rectangle of exactly the given colour, exactly over that element's area (a photo: its whole photo area; the logo: the logo's area). Change NOTHING else — every other pixel, word, colour and position stays exactly the same.",
        ...missing.map((x) => `- ${x.label} → solid ${x.color.hex} (${x.color.name})`),
        "The rectangles are solid colour edge to edge: no outline, no frame, nothing inside them.",
      ].join("\n");
      const meta = await sharp(png).metadata();
      const repaired = await drawFast({ prompt, size: `${meta.width}x${meta.height}`, images: [png] }, turn.image_model ?? imageModel());
      const pic = await sharp(Buffer.from(repaired, "base64")).resize({ width: meta.width, height: meta.height, fit: "fill" }).png().toBuffer();
      const still = await missingBoxes(pic);
      if (still.length < missing.length) png = pic;
      if (still.length) log(`[email-ai] turn ${turn.id} ${step}: still no box for ${still.map((x) => x.key).join(", ")}`);
    } catch (e) {
      log(`[email-ai] turn ${turn.id} ${step}: repair failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const r = await pasteReal(png, slots, loader, logos);
  return r.png;
}

async function toPng(b: Buffer): Promise<Buffer> {
  return sharp(b).rotate().png({ compressionLevel: 9 }).toBuffer();
}

/** Save a drawn picture; the phone bottom part is joined under the top part into one phone picture. */
async function savePicture(pool: Pool, turn: Msg, step: Step, b64: string): Promise<{ column: "desktop_path" | "mobile_top_path" | "mobile_path"; path: string }> {
  const png = await withRealPictures(pool, turn, step, await sharp(Buffer.from(b64, "base64")).png({ compressionLevel: 9 }).toBuffer());
  if (step === "desktop" || step === "mobile-top") {
    const path = `email/designs/${turn.design_id}/${turn.id}-${step}.png`;
    await uploadBytesToStorage({ path, bytes: png, contentType: "image/png" });
    return { column: step === "desktop" ? "desktop_path" : "mobile_top_path", path };
  }
  const topBuf = await load(turn.mobile_top_path!);
  const t = await sharp(topBuf).metadata();
  const bot = await sharp(png).resize({ width: t.width }).toBuffer();
  const b = await sharp(bot).metadata();
  const joined = await sharp({ create: { width: t.width ?? 1120, height: (t.height ?? 0) + (b.height ?? 0), channels: 3, background: "#ffffff" } })
    .composite([
      { input: topBuf, top: 0, left: 0 },
      { input: bot, top: t.height ?? 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  const path = `email/designs/${turn.design_id}/${turn.id}-mobile.png`;
  await uploadBytesToStorage({ path, bytes: joined, contentType: "image/png" });
  return { column: "mobile_path", path };
}

async function drawFast(inputs: Inputs, model: string = imageModel()): Promise<string> {
  const ai = openai();
  const common = { model, prompt: inputs.prompt, size: inputs.size as "1024x1536", quality: "high" as const, n: 1 };
  const r = inputs.images.length
    ? await ai.images.edit({ ...common, image: await Promise.all(inputs.images.map(async (b, i) => toFile(await toPng(b), `ref-${i}.png`, { type: "image/png" }))) })
    : await ai.images.generate({ ...common, moderation: "low" });
  const b64 = r.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no picture");
  return b64;
}

async function submitBatch(turn: Msg, step: Step, inputs: Inputs): Promise<Stage> {
  const ai = openai();
  const refFileIds: string[] = [];
  for (const [i, b] of inputs.images.entries()) {
    const jpg = await sharp(b).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
    const f = await ai.files.create({ file: await toFile(jpg, `email-${turn.id}-${step}-${i}.jpg`, { type: "image/jpeg" }), purpose: "vision" });
    refFileIds.push(f.id);
  }
  const edit = refFileIds.length > 0;
  const line = {
    custom_id: `${turn.id}:${step}`,
    method: "POST",
    url: edit ? "/v1/images/edits" : "/v1/images/generations",
    body: {
      model: turn.image_model ?? imageModel(),
      prompt: inputs.prompt,
      size: inputs.size,
      quality: "high",
      moderation: "low",
      n: 1,
      ...(edit ? { images: refFileIds.map((file_id) => ({ file_id })) } : {}),
    },
  };
  const input = await ai.files.create({ file: await toFile(Buffer.from(JSON.stringify(line) + "\n"), `email-${turn.id}-${step}.jsonl`, { type: "application/jsonl" }), purpose: "batch" });
  const batch = await ai.batches.create({
    input_file_id: input.id,
    endpoint: edit ? "/v1/images/edits" : "/v1/images/generations",
    completion_window: "24h",
    metadata: { email_design_turn: turn.id, view: step },
  });
  return { view: step, batchId: batch.id, inputFileId: input.id, refFileIds };
}

async function cleanup(ai: OpenAI, st: Stage | null, ...more: (string | null | undefined)[]) {
  const s = st && st.view !== "member" ? st : null;
  for (const f of [s?.inputFileId, ...(s?.refFileIds ?? []), ...more]) if (f) await ai.files.delete(f).catch(() => {});
}

async function fail(pool: Pool, id: string, why: string) {
  await pool.query(`UPDATE email_design_messages SET status = 'failed', error = $2, finished_at = now() WHERE id = $1::uuid`, [id, why.slice(0, 800)]);
}

/** The pictures this turn still has to draw, in order. */
function stepsToDraw(turn: Msg): Step[] {
  const out: Step[] = [];
  if (turn.target !== "mobile" && !turn.desktop_path) out.push("desktop");
  if (turn.target !== "desktop") {
    if (!turn.mobile_top_path && !turn.mobile_path) out.push("mobile-top");
    if (!turn.mobile_path) out.push("mobile-bottom");
  }
  return out;
}

/** Finish: carry over the view that did not change. */
async function complete(pool: Pool, turn: Msg) {
  const prev = await baseVersion(pool, turn.design_id, turn.created_at);
  await pool.query(
    `UPDATE email_design_messages SET status = 'done', finished_at = now(), batch_id = NULL, batch_files = NULL,
            desktop_path = COALESCE(desktop_path, $2), mobile_path = COALESCE(mobile_path, $3) WHERE id = $1::uuid`,
    [turn.id, prev?.desktop_path ?? null, prev?.mobile_path ?? null],
  );
  await pool.query(`UPDATE email_designs SET updated_at = now() WHERE id = $1::uuid`, [turn.design_id]);
}

function setPath(turn: Msg, column: "desktop_path" | "mobile_top_path" | "mobile_path", path: string) {
  turn[column] = path;
}

/** Draw the next pictures of a turn (fast: now; batch: submit one and wait). */
async function drawNext(pool: Pool, turn: Msg, log: (m: string) => void): Promise<void> {
  for (const step of stepsToDraw(turn)) {
    const inputs = await inputsFor(pool, turn, step);
    if (turn.mode === "fast") {
      await pool.query(`UPDATE email_design_messages SET status = 'generating', batch_files = NULL, batch_id = NULL, concept = $2, step_at = now() WHERE id = $1::uuid`, [turn.id, step]);
      const b64 = await drawFast(inputs, turn.image_model ?? imageModel());
      const saved = await savePicture(pool, turn, step, b64);
      await pool.query(`UPDATE email_design_messages SET ${saved.column} = $2 WHERE id = $1::uuid`, [turn.id, saved.path]);
      setPath(turn, saved.column, saved.path);
      log(`[email-ai] turn ${turn.id}: ${step} drawn (fast)`);
      continue;
    }
    const st = await submitBatch(turn, step, inputs);
    await pool.query(`UPDATE email_design_messages SET status = 'generating', batch_id = $2, batch_files = $3, concept = $4 WHERE id = $1::uuid`, [turn.id, st.batchId, JSON.stringify(st), step]);
    log(`[email-ai] turn ${turn.id}: ${step} sent to the OpenAI batch ${st.batchId}`);
    return;
  }
  await complete(pool, turn);
}

/* -------------------------------------------------------- review (approval) */

/** One person's outfit as the owner approved it (owner, 2026-11-08: approve each person's look in its own row). */
export type OutfitEdit = { key: string; person: number; productIds: string[] };

/**
 * The owner's approved items: products (ids; a set piece brings its set) and CARBON pictures (ids).
 * With `outfits` (the review shown per person), the concept is updated directly — the swapped / added /
 * removed pieces go into that person's outfit, the concept stays, and only the photos whose outfits
 * changed are drawn again.
 */
export async function approveItems(pool: Pool, designId: string, messageId: string, productIds: string[], mediaIds: string[], outfits?: OutfitEdit[]): Promise<void> {
  const r = await pool.query<{ variant_group: string | null; products: TurnProduct[] | null; media: TurnMedia[] | null; concept_data: Concept | null; shots: Shot[] | null }>(
    `SELECT variant_group::text, products, media, concept_data, shots FROM email_design_messages WHERE id = $1::uuid AND design_id = $2::uuid AND role = 'ai' AND status = 'review'`,
    [messageId, designId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("This version is not waiting for approval");
  const catalog = await inStockCatalog().catch(() => [] as CatalogProduct[]);
  const sets = catalogSets(catalog);
  if (outfits?.length && row.concept_data) {
    const known = new Map((row.products ?? []).map((p) => [p.id, p]));
    const expand = (ids: string[]) => {
      const fromCat = turnProducts(ids.filter((id) => catalog.some((c) => c.id === id)), catalog, sets);
      return [...fromCat, ...ids.filter((id) => !fromCat.some((p) => p.id === id) && known.has(id)).map((id) => known.get(id)!)];
    };
    const concept: Concept = JSON.parse(JSON.stringify(row.concept_data));
    const sections = [{ key: "h1", part: concept.hero }, ...concept.looks.map((l, i) => ({ key: `l${i + 1}`, part: l }))];
    const all: TurnProduct[] = [];
    for (const o of outfits) {
      const sec = sections.find((x) => x.key === o.key);
      const person = sec?.part.people?.[o.person];
      if (!sec || !person) continue;
      const items = expand(o.productIds.slice(0, 12));
      person.products = items.map((p) => p.id);
      for (const p of items) if (!all.some((x) => x.id === p.id)) all.push(p);
    }
    for (const sec of sections) sec.part.products = [...new Set((sec.part.people ?? []).flatMap((x) => x.products))];
    const library = await mediaLibrary(pool, 400);
    const media = mediaIds
      .map((id) => (row.media ?? []).find((m) => m.id === id) ?? library.find((m) => m.id === id))
      .filter((m): m is TurnMedia => !!m)
      .slice(0, MAX_MEDIA)
      .map((m) => ({ id: m.id, url: m.url, width: m.width, height: m.height, kind: m.kind, description: m.description }));
    const same = JSON.stringify(concept) === JSON.stringify(row.concept_data) && JSON.stringify((row.media ?? []).map((m) => m.id).sort()) === JSON.stringify(media.map((m) => m.id).sort());
    const shots = shotsFor(concept, (id) => [id], row.shots);
    const ids = [messageId]; // each direction has its own concept and outfits (owner, 2026-11-08)
    await pool.query(
      `UPDATE email_design_messages SET products = $2, media = $3, needs_review = false, concept_data = CASE WHEN id = $4::uuid THEN $6::jsonb ELSE concept_data END,
              shots = CASE WHEN id = $4::uuid THEN $7::jsonb ELSE shots END,
              status = CASE WHEN id = $4::uuid THEN 'approved' ELSE status END,
              desktop_prompt = CASE WHEN $5 AND id = $4::uuid THEN desktop_prompt ELSE NULL END,
              mobile_prompt = CASE WHEN $5 AND id = $4::uuid THEN mobile_prompt ELSE NULL END
        WHERE id = ANY($1::uuid[])`,
      [ids, JSON.stringify(same ? (row.products ?? all) : all), JSON.stringify(media), messageId, same, JSON.stringify(concept), JSON.stringify(shots)],
    );
    return;
  }
  const known = new Map((row.products ?? []).map((p) => [p.id, p]));
  const fromCatalog = turnProducts(productIds.filter((id) => catalog.some((c) => c.id === id)), catalog, sets);
  // Items the AI chose that left the catalog meanwhile stay if the owner kept them.
  const products = [...fromCatalog, ...productIds.filter((id) => !fromCatalog.some((p) => p.id === id) && known.has(id)).map((id) => known.get(id)!)].slice(0, MAX_PRODUCTS);
  const library = await mediaLibrary(pool, 400);
  const media = mediaIds
    .map((id) => (row.media ?? []).find((m) => m.id === id) ?? library.find((m) => m.id === id))
    .filter((m): m is TurnMedia => !!m)
    .slice(0, MAX_MEDIA)
    .map((m) => ({ id: m.id, url: m.url, width: m.width, height: m.height, kind: m.kind, description: m.description }));
  const same =
    JSON.stringify((row.products ?? []).map((p) => p.id).sort()) === JSON.stringify(products.map((p) => p.id).sort()) &&
    JSON.stringify((row.media ?? []).map((m) => m.id).sort()) === JSON.stringify(media.map((m) => m.id).sort());
  // Changed items: the briefs are rewritten around exactly these (prompts cleared → re-planned).
  const ids = [messageId];
  await pool.query(
    `UPDATE email_design_messages SET products = $2, media = $3, needs_review = false,
            status = CASE WHEN id = $4::uuid THEN 'approved' ELSE status END,
            desktop_prompt = CASE WHEN $5 AND id = $4::uuid THEN desktop_prompt ELSE NULL END,
            mobile_prompt = CASE WHEN $5 AND id = $4::uuid THEN mobile_prompt ELSE NULL END,
            concept_data = CASE WHEN $5 THEN concept_data ELSE NULL END,
            shots = CASE WHEN $5 THEN shots ELSE NULL END
      WHERE id = ANY($1::uuid[])`,
    [ids, JSON.stringify(products), JSON.stringify(media), messageId, same],
  );
}

/** Catalog search for the review step (swap / add an item). */
export async function searchCatalog(q: string): Promise<{ id: string; title: string; price: number; image: string | null; set: { name: string; line: string; total: number } | null; stock: number }[]> {
  const catalog = await inStockCatalog();
  const sets = catalogSets(catalog);
  const setOf = new Map<string, CatalogSet>();
  for (const s of sets) for (const p of s.pieces) setOf.set(p.id, s);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (p: CatalogProduct) => {
    const hay = `${p.title} ${p.type} ${p.gender} ${p.colors.join(" ")} ${setOf.get(p.id)?.name ?? ""}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const out: { id: string; title: string; price: number; image: string | null; set: { name: string; line: string; total: number } | null; stock: number }[] = [];
  const seenSets = new Set<string>();
  for (const p of catalog) {
    if (out.length >= 40) break;
    if (words.length && !hit(p)) continue;
    const s = setOf.get(p.id);
    if (s) {
      if (seenSets.has(s.ref)) continue;
      seenSets.add(s.ref);
      out.push({ id: s.lead.id, title: s.name, price: s.total, image: s.lead.image, set: { name: s.name, line: s.piecesLine, total: s.total }, stock: Math.min(...s.pieces.map((x) => x.stock)) });
    } else out.push({ id: p.id, title: p.title, price: p.price, image: p.image, set: null, stock: p.stock });
  }
  return out;
}

/* --------------------------------------------------------------- the runner */

async function storePlan(pool: Pool, turn: Msg, p: Plan, status: string): Promise<void> {
  await pool.query(
    `UPDATE email_design_messages SET text = $2, desktop_prompt = $3, mobile_prompt = $4, products = $5, media = $6, direction = $7, fresh = $8, status = $9
      WHERE id = $1::uuid AND status IN ('planning', 'approved-planning', 'generating')`,
    [turn.id, p.reply, p.desktop_prompt, p.mobile_prompt, JSON.stringify(p.products), JSON.stringify(p.media), p.direction, p.fresh, status],
  );
  if (!turn.variant_group || turn.variant_no === 1)
    await pool.query(
      `UPDATE email_designs SET title = CASE WHEN title = 'New email' AND $2::text IS NOT NULL THEN $2 ELSE title END,
              subject_hint = COALESCE($3, subject_hint), preheader_hint = COALESCE($4, preheader_hint), updated_at = now() WHERE id = $1::uuid`,
      [turn.design_id, p.title, p.subject, p.preheader],
    );
  Object.assign(turn, { text: p.reply, desktop_prompt: p.desktop_prompt, mobile_prompt: p.mobile_prompt, products: p.products, media: p.media, direction: p.direction, fresh: p.fresh });
}

/** One picture turn: plan (or re-plan around approved items), stop for review, or draw. */
/** A Responses-API picture part from a stored picture. */
async function stored(path: string, w = 900): Promise<Buffer> {
  return sharp(await load(path)).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
}

/** Step 1: the editorial concept (creative-director model). Locked items = the owner approved changed items. */
async function makeConcept(pool: Pool, turn: Msg, lockedItems: TurnProduct[] | null, siblings: Concept[] = []): Promise<{ concept: Concept; keep: boolean; reply: string; title: string | null; subject: string | null; preheader: string | null; direction: string | null; products: TurnProduct[]; model: string }> {
  const settings = await getEmailSettings(pool, await tenantOf(pool, turn.design_id));
  const history = await pool.query<{ role: string; text: string; target: string; attachments: { path: string; name: string }[] }>(
    `SELECT m.role, m.text, m.target, m.attachments FROM email_design_messages m
      WHERE m.design_id = $1::uuid AND m.created_at < $2 AND (m.role = 'owner' OR (m.status = 'done' AND ${CHOSEN})) ORDER BY m.created_at`,
    [turn.design_id, turn.created_at],
  );
  const base = await pool.query<{ concept_data: Concept | null; desktop_path: string | null }>(
    `SELECT m.concept_data, m.desktop_path FROM email_design_messages m WHERE m.design_id = $1::uuid AND m.role = 'ai' AND m.status = 'done' AND m.created_at < $2 AND ${CHOSEN} ORDER BY m.created_at DESC LIMIT 1`,
    [turn.design_id, turn.created_at],
  );
  const prev = base.rows[0];
  // Owner, 2026-11-08: a new idea every time — the creative director sees the store's recent concepts.
  const recent = await pool.query<{ concept_data: Concept }>(
    `SELECT DISTINCT ON (m.concept_data->>'story') m.concept_data FROM email_design_messages m JOIN email_designs d ON d.id = m.design_id
      WHERE d.tenant_id = (SELECT tenant_id FROM email_designs WHERE id = $1::uuid) AND m.concept_data IS NOT NULL AND m.id <> $2::uuid
      ORDER BY m.concept_data->>'story', m.created_at DESC LIMIT 8`,
    [turn.design_id, turn.id],
  );
  const catalog = await inStockCatalog().catch(() => [] as CatalogProduct[]);
  const sets = catalogSets(catalog);
  const refOf = (id: string) => sets.find((x) => x.pieces.some((p) => p.id === id))?.ref ?? catalog.find((c) => c.id === id)?.ref ?? id;
  const owner = history.rows.filter((h) => h.role === "owner").at(-1);
  const parts = [
    txt(`${STORE_TEXT}\n\nConversation so far:\n${history.rows.map((h) => (h.role === "owner" ? "OWNER" : "YOU") + `: ${h.text}`).join("\n")}`),
  ];
  const nameOf = (id: string) => {
    const set = sets.find((x) => x.pieces.some((q) => q.id === id));
    if (set) return `${set.ref} ${set.name}`;
    const p = catalog.find((x) => x.id === id);
    return p ? `${p.ref} ${p.title}` : "(no longer in stock)";
  };
  if (prev?.concept_data) parts.push(txt(`THE CURRENT CONCEPT:\n${conceptText(prev.concept_data, nameOf)}`));
  // Owner, 2026-11-08: each of the 3 directions is a completely different idea with its own outfits and photos.
  if (turn.variant_no)
    parts.push(
      txt(
        `THIS IS DIRECTION ${turn.variant_no} OF 3 for the owner's last message — a COMPLETELY DIFFERENT IDEA from the other directions: a different story, different places and time of day, different people, and different outfits (different pieces).` +
          (siblings.length ? `\nThe other directions already are:\n${siblings.map((c, i) => `${i + 1}. ${conceptText(c, nameOf)}`).join("\n\n")}` : ""),
      ),
    );
  const others = recent.rows.map((r) => r.concept_data).filter((c) => !prev?.concept_data || c.story !== prev.concept_data.story);
  if (others.length)
    parts.push(
      txt(
        `RECENT CARBON EMAILS (do NOT repeat them — when you make a new concept, choose a different idea, different places, a different time of day, light and mood, different people and different pieces):\n${others
          .map((c, i) => `${i + 1}. ${c.story} | hero: ${c.hero.scene.slice(0, 160)} | looks: ${c.looks.map((l) => `${l.name} (${l.scene.slice(0, 90)})`).join("; ")}`)
          .join("\n")}`,
      ),
    );
  if (prev?.desktop_path) parts.push(txt("The current desktop picture:"), img(await stored(prev.desktop_path), "low"));
  if (lockedItems?.length)
    parts.push(txt(`THE ITEMS ARE FIXED (the owner approved exactly these): build the hero and the three looks from them only, using every one:\n${[...new Set(lockedItems.map((p) => refOf(p.id)))].map((r) => `- ${r}`).join("\n")}`));
  parts.push(txt(catalog.length ? `CATALOG (in stock) — ref | name | type | men/women | colours | price | stock:\n${catalogLines(catalog, sets)}` : "The catalog could not be read: use no specific products."));
  for (const [i, a] of (owner?.attachments ?? []).entries()) parts.push(txt(`Attached photo A${i + 1} (${a.name}):`), img(await stored(a.path, 640), "low"));
  const { json, model } = await creativeJson(settings.creativeModel, CONCEPT_RULES, parts);
  const keep = json.change === "keep" && !!prev?.concept_data && !lockedItems;
  const concept = keep ? prev!.concept_data! : cleanConcept(json);
  const refs = [...new Set([...concept.hero.products, ...concept.looks.flatMap((l) => l.products), ...(Array.isArray(json.products) ? (json.products as unknown[]).map(String) : [])])];
  const products = lockedItems && !keep ? lockedItems : turnProducts(refs, catalog, sets);
  // Concept product refs → ids (stable across catalog changes).
  const idOf = (ref: string) => {
    const set = sets.find((x) => x.ref === ref);
    if (set) return set.pieces.map((p) => p.id);
    const p = catalog.find((x) => x.ref === ref);
    return p ? [p.id] : [];
  };
  if (!keep) {
    concept.hero.products = concept.hero.products.flatMap(idOf);
    for (const ps of concept.hero.people ?? []) ps.products = ps.products.flatMap(idOf);
    for (const l of concept.looks) {
      l.products = l.products.flatMap(idOf);
      for (const ps of l.people ?? []) ps.products = ps.products.flatMap(idOf);
    }
  }
  const str = (v: unknown, n: number) => (v ? String(v).slice(0, n) : null);
  return { concept, keep, reply: String(json.reply ?? "Here is the idea.").slice(0, 1200), title: str(json.title, 80), subject: str(json.subject, 120), preheader: str(json.preheader, 200), direction: str(json.direction, 160), products, model };
}

/**
 * Step 1 for a turn. False = stopped (waiting for the owner's approval).
 * Directions 2–3 take direction 1's concept, items and photos.
 */
async function conceptStep(pool: Pool, turn: Msg, log: (m: string) => void, siblings: Concept[] = []): Promise<boolean> {
  if (turn.concept_data) return true;
  const approved = turn.status === "approved-planning";
  await pool.query(`UPDATE email_design_messages SET status = 'planning', concept = 'concept', step_at = now() WHERE id = $1::uuid`, [turn.id]);
  const settings = await getEmailSettings(pool, await tenantOf(pool, turn.design_id));
  const c = await makeConcept(pool, turn, approved ? (turn.products ?? []) : null, siblings);
  const base = await pool.query<{ shots: Shot[] | null; media: TurnMedia[] | null }>(
    `SELECT m.shots, m.media FROM email_design_messages m WHERE m.design_id = $1::uuid AND m.role = 'ai' AND m.status = 'done' AND m.created_at < $2 AND ${CHOSEN} ORDER BY m.created_at DESC LIMIT 1`,
    [turn.design_id, turn.created_at],
  );
  const prevShots = base.rows[0]?.shots ?? null;
  Object.assign(turn, {
    concept_data: c.concept,
    products: c.products,
    media: turn.media ?? base.rows[0]?.media ?? [],
    shots: shotsFor(c.concept, (id) => [id], c.keep ? prevShots : prevShots),
    creative_model: c.model,
    image_model: settings.imageModel,
    direction: c.direction,
  });
  const review = !!turn.needs_review && !approved && !c.keep;
  await pool.query(
    `UPDATE email_design_messages SET text = $2, concept_data = $3, products = $4, media = $5, shots = $6, creative_model = $7, image_model = $8, direction = $9, status = $10 WHERE id = $1::uuid`,
    [turn.id, c.reply, JSON.stringify(c.concept), JSON.stringify(c.products), JSON.stringify(turn.media), JSON.stringify(turn.shots), c.model, settings.imageModel, c.direction, review ? "review" : "planning"],
  );
  if (!turn.variant_group || turn.variant_no === 1)
    await pool.query(
      `UPDATE email_designs SET title = CASE WHEN title = 'New email' AND $2::text IS NOT NULL THEN $2 ELSE title END,
              subject_hint = COALESCE($3, subject_hint), preheader_hint = COALESCE($4, preheader_hint), updated_at = now() WHERE id = $1::uuid`,
      [turn.design_id, c.title, c.subject, c.preheader],
    );
  turn.text = c.reply;
  log(`[email-ai] turn ${turn.id}: concept by ${c.model}${c.keep ? " (kept)" : ""}${review ? ", waiting for approval" : ""}`);
  return !review;
}

async function runPictureTurn(pool: Pool, turn: Msg, log: (m: string) => void): Promise<void> {
  // Owner, 2026-11-08: each of the 3 directions is a completely different idea with its own outfits and
  // photos. Direction 1 starts directions 2–3 at once; their concepts are written one after another so
  // each can differ from the ones before; then every direction (or each one as soon as the owner approves
  // it) draws its own photos and pictures — all at the same time, nobody waits for anybody.
  const group: Msg[] = [turn];
  if (turn.variant_group && turn.variant_no === 1 && !turn.concept_data) {
    const sibs = await pool.query<Msg>(
      `UPDATE email_design_messages SET status = 'planning', step_at = now() WHERE variant_group = $1::uuid AND variant_no > 1 AND status = 'queued' RETURNING *`,
      [turn.variant_group],
    );
    group.push(...sibs.rows.sort((a, b) => (a.variant_no ?? 0) - (b.variant_no ?? 0)));
  }
  const made: Concept[] = [];
  const ready: Msg[] = [];
  for (const t of group) {
    try {
      if (await conceptStep(pool, t, log, made)) ready.push(t);
      if (t.concept_data) made.push(t.concept_data);
    } catch (e) {
      await fail(pool, t.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await Promise.all(
    ready.map(async (t) => {
      try {
        if (await planPictureTurn(pool, t, log)) await drawAll(pool, t, [t], log);
      } catch (e) {
        await fail(pool, t.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
}

const shotOpts = (t: Msg) => ({ designId: t.design_id, turnId: t.id, imageModel: t.image_model ?? imageModel(), creativeModel: t.creative_model?.split(" ")[0] ?? "gpt-6-astra" });

/** Save a turn's drawn pictures in order (desktop, phone top, phone bottom — the bottom is joined under the top), then finish it. */
async function finishTurn(pool: Pool, t: Msg, pics: Map<Step, string>, log: (m: string) => void): Promise<void> {
  for (const step of ["desktop", "mobile-top", "mobile-bottom"] as Step[]) {
    if (!stepsToDraw(t).includes(step)) continue;
    let b64 = pics.get(step);
    if (!b64) b64 = await drawFast(await inputsFor(pool, t, step), t.image_model ?? imageModel()); // missing from the batch: draw it now
    const saved = await savePicture(pool, t, step, b64);
    await pool.query(`UPDATE email_design_messages SET ${saved.column} = $2 WHERE id = $1::uuid`, [t.id, saved.path]);
    setPath(t, saved.column, saved.path);
  }
  await complete(pool, t);
  log(`[email-ai] turn ${t.id}: done`);
}

/** Campaign photos to every turn of the message (they share them). */
async function shareShots(pool: Pool, turns: Msg[], shots: Shot[]): Promise<void> {
  for (const t of turns) {
    t.shots = shots;
    await pool.query(`UPDATE email_design_messages SET shots = $2 WHERE id = $1::uuid`, [t.id, JSON.stringify(shots)]);
  }
}

/** Steps 2 + 3 together: the campaign photos and every picture of every turn, all at once. */
async function drawAll(pool: Pool, lead: Msg, turns: Msg[], log: (m: string) => void): Promise<void> {
  const o = shotOpts(lead);
  const shots = lead.shots ?? [];
  const model = lead.image_model ?? imageModel();
  for (const t of turns)
    await pool.query(`UPDATE email_design_messages SET status = 'generating', concept = 'all', step_at = now(), batch_id = NULL, batch_files = $2 WHERE id = $1::uuid`, [
      t.id,
      t.id === lead.id || lead.mode === "fast" ? null : JSON.stringify({ view: "member", lead: lead.id }),
    ]);
  if (lead.mode !== "fast") {
    // ONE OpenAI batch with everything (half price).
    const ai = openai();
    const refFileIds: string[] = [];
    const lines: string[] = [];
    const upload = async (images: Buffer[], tag: string) => {
      const ids: string[] = [];
      for (const [i, b] of images.entries()) {
        const jpg = await sharp(b).rotate().flatten({ background: "#ffffff" }).jpeg({ quality: 92 }).toBuffer();
        const f = await ai.files.create({ file: await toFile(jpg, `email-${tag}-${i}.jpg`, { type: "image/jpeg" }), purpose: "vision" });
        ids.push(f.id);
      }
      refFileIds.push(...ids);
      return ids;
    };
    const line = (custom_id: string, prompt: string, size: string, ids: string[]) =>
      JSON.stringify({
        custom_id,
        method: "POST",
        url: "/v1/images/edits",
        body: { model, prompt, size, quality: "high", moderation: "low", n: 1, images: ids.map((file_id) => ({ file_id })) },
      });
    for (const s of shots.filter((x) => !x.path)) {
      const inp = await shotInputs(s, lead.products ?? []);
      lines.push(line(`${lead.id}:shot:${s.id}`, inp.prompt, s.size, await upload(inp.images, `${lead.id}-${s.id}`)));
    }
    for (const t of turns)
      for (const step of stepsToDraw(t)) {
        const inp = await inputsFor(pool, t, step);
        // The edits endpoint needs at least one picture: a blank page when a step has none.
        const imgs = inp.images.length ? inp.images : [await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ffffff" } }).png().toBuffer()];
        lines.push(line(`${t.id}:pic:${step}`, inp.prompt, inp.size, await upload(imgs, `${t.id}-${step}`)));
      }
    const input = await ai.files.create({ file: await toFile(Buffer.from(lines.join("\n") + "\n"), `email-${lead.id}-all.jsonl`, { type: "application/jsonl" }), purpose: "batch" });
    const batch = await ai.batches.create({ input_file_id: input.id, endpoint: "/v1/images/edits", completion_window: "24h", metadata: { email_design_turn: lead.id, kind: "all" } });
    const st = { view: "all" as const, batchId: batch.id, inputFileId: input.id, refFileIds, turnIds: turns.map((t) => t.id) };
    await pool.query(`UPDATE email_design_messages SET batch_id = $2, batch_files = $3 WHERE id = $1::uuid`, [lead.id, batch.id, JSON.stringify(st)]);
    log(`[email-ai] ${lead.id}: ${lines.length} picture(s) (photos + ${turns.length} version(s)) sent to the OpenAI batch ${batch.id}`);
    return;
  }
  // Fast: everything in parallel.
  const shotsP = shots.some((x) => !x.path) ? drawShotsFast(o, shots, lead.products ?? [], log) : Promise.resolve(shots);
  const picsP = Promise.all(
    turns.map(async (t) => {
      try {
        const pics = new Map<Step, string>();
        await Promise.all(
          stepsToDraw(t).map(async (step) => {
            pics.set(step, await drawFast(await inputsFor(pool, t, step), model));
          }),
        );
        return { t, pics, error: null as string | null };
      } catch (e) {
        return { t, pics: new Map<Step, string>(), error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
  const [doneShots, drawn] = await Promise.all([shotsP, picsP]);
  await shareShots(pool, turns, doneShots);
  await Promise.all(
    drawn.map(async ({ t, pics, error }) => {
      if (error) return fail(pool, t.id, `The AI could not make this version: ${error}`);
      await finishTurn(pool, t, pics, log).catch((e) => fail(pool, t.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`));
    }),
  );
}

/** The one batch of a message came back: check the photos, paste them into every picture, finish every version. */
async function collectAll(pool: Pool, lead: Msg, st: Extract<Stage, { view: "all" }>, log: (m: string) => void): Promise<boolean> {
  const ai = openai();
  const b = await ai.batches.retrieve(st.batchId);
  if (["validating", "in_progress", "finalizing", "cancelling"].includes(b.status)) return false;
  const got = new Map<string, string>();
  if (b.output_file_id) {
    const text = await (await ai.files.content(b.output_file_id)).text();
    for (const l of text.split("\n").filter(Boolean)) {
      const j = JSON.parse(l) as { custom_id: string; response?: { body?: { data?: { b64_json?: string }[] } } };
      const b64 = j.response?.body?.data?.[0]?.b64_json;
      if (b64) got.set(j.custom_id, b64);
    }
  }
  for (const f of [st.inputFileId, ...st.refFileIds, b.output_file_id, b.error_file_id]) if (f) await ai.files.delete(f).catch(() => {});
  await pool.query(`UPDATE email_design_messages SET batch_id = NULL, batch_files = NULL, step_at = now() WHERE id = ANY($1::uuid[])`, [st.turnIds]);
  // 1. The campaign photos: checked against the real products (a missing one is drawn now).
  const o = shotOpts(lead);
  const shots = await Promise.all(
    (lead.shots ?? []).map(async (s) => {
      if (s.path) return s;
      try {
        let b64 = got.get(`${lead.id}:shot:${s.id}`);
        if (!b64) {
          const inp = await shotInputs(s, lead.products ?? []);
          b64 = await drawFast({ prompt: inp.prompt, size: s.size, images: inp.images }, o.imageModel);
        }
        return await finishShot(o, s, b64, lead.products ?? [], log);
      } catch (e) {
        return { ...s, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
      }
    }),
  );
  const turns = (await pool.query<Msg>(`SELECT * FROM email_design_messages WHERE id = ANY($1::uuid[]) AND status = 'generating'`, [st.turnIds])).rows;
  await shareShots(pool, turns, shots);
  // 2. Every version: paste the real pictures, join the phone parts, finish.
  await Promise.all(
    turns.map(async (t) => {
      const pics = new Map<Step, string>();
      for (const step of ["desktop", "mobile-top", "mobile-bottom"] as Step[]) {
        const b64 = got.get(`${t.id}:pic:${step}`);
        if (b64) pics.set(step, b64);
      }
      await finishTurn(pool, t, pics, log).catch((e) => fail(pool, t.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`));
    }),
  );
  return true;
}

/** Steps 2 (comps): brief(s), then draw; direction 1 starts directions 2–3 so all three draw together. */
async function afterShots(pool: Pool, turn: Msg, log: (m: string) => void): Promise<void> {
  if (!(await planPictureTurn(pool, turn, log))) return;
  // Direction 1 has its concept and photos: start directions 2 and 3 right now, plan them side by
  // side, then all three draw at the same time (owner, 2026-11-08: "why doesn't it generate all 3 at once?").
  if (turn.variant_group && turn.variant_no === 1) {
    const sibs = await pool.query<Msg>(
      `UPDATE email_design_messages SET status = 'planning', step_at = now() WHERE variant_group = $1::uuid AND variant_no > 1 AND status = 'queued' RETURNING *`,
      [turn.variant_group],
    );
    const ready = await Promise.all(
      sibs.rows.map((sib) =>
        conceptStep(pool, sib, log)
          .then(() => planPictureTurn(pool, sib, log))
          .then(
            (ok) => (ok ? sib : null),
            async (e) => {
              await fail(pool, sib.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`);
              return null;
            },
          ),
      ),
    );
    await Promise.all(
      [turn, ...ready.filter((x): x is Msg => !!x)].map((t) =>
        drawNext(pool, t, log).catch(async (e) => {
          await fail(pool, t.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`);
        }),
      ),
    );
    return;
  }
  await drawNext(pool, turn, log);
}

/** Plan a picture turn. True when it is ready to draw (false: waiting for the owner's approval). */
async function planPictureTurn(pool: Pool, turn: Msg, log: (m: string) => void): Promise<boolean> {
  // Directions 2 and 3 share direction 1's items.
  if (turn.variant_no && turn.variant_no > 1 && !turn.products) {
    const v1 = await pool.query<{ products: TurnProduct[] | null; media: TurnMedia[] | null }>(
      `SELECT products, media FROM email_design_messages WHERE variant_group = $1::uuid AND variant_no = 1`,
      [turn.variant_group],
    );
    turn.products = v1.rows[0]?.products ?? [];
    turn.media = v1.rows[0]?.media ?? [];
  }
  const approvedAlready = turn.status === "approved-planning" && !turn.concept_data;
  const locked = turn.products && (approvedAlready || (turn.variant_no ?? 0) > 1 || !!turn.concept_data) ? { products: turn.products, media: turn.media ?? [] } : null;
  // An approved turn whose items did not change keeps its briefs.
  if (approvedAlready && (turn.desktop_prompt || turn.mobile_prompt)) return true;
  await pool.query(`UPDATE email_design_messages SET status = 'planning' WHERE id = $1::uuid`, [turn.id]);
  const p = await plan(pool, turn, locked);
  const review = !!turn.needs_review && !locked && !turn.concept_data && (!turn.variant_no || turn.variant_no === 1);
  // The concept's reply stays the message text; the designer's reply is only used without a concept.
  if (turn.concept_data) p.reply = turn.text || p.reply;
  if (turn.style && p.fresh) p.direction = `${styleName(turn.style)}${p.direction ? ` — ${p.direction}` : ""}`.slice(0, 200);
  await storePlan(pool, turn, p, review ? "review" : "planning");
  if (review) {
    log(`[email-ai] turn ${turn.id}: waiting for the owner to approve ${p.products.length} item(s)`);
    return false;
  }
  return true;
}

/** Called by the tick. */
export async function runDesignTurns(pool: Pool, log: (m: string) => void = console.log): Promise<{ planned: number; collected: number }> {
  let planned = 0;
  let collected = 0;
  // 0. A turn cut off by a restart while planning / drawing fast.
  await pool.query(
    `UPDATE email_design_messages SET status = 'failed', error = 'Interrupted (the server restarted). Send the message again.', finished_at = now()
      WHERE status IN ('planning','generating','approved-planning') AND batch_id IS NULL AND batch_files IS NULL
        AND COALESCE(step_at, created_at) < now() - interval '45 minutes'`,
  );
  // 1. Turns to start: new ones, approved ones, and directions 2-3 once direction 1 has its items.
  const claimed = await pool.query<Msg>(
    `UPDATE email_design_messages m SET status = CASE WHEN m.status = 'approved' THEN 'approved-planning' ELSE 'planning' END, step_at = now()
      WHERE m.id IN (
        SELECT q.id FROM email_design_messages q
         WHERE (q.status = 'approved'
            OR (q.status = 'queued' AND (q.variant_no IS NULL OR q.variant_no = 1
                -- Directions 2-3 are started by direction 1's own run (so all three draw together);
                -- this is only the fallback when that run is gone.
                OR EXISTS (SELECT 1 FROM email_design_messages v WHERE v.variant_group = q.variant_group AND v.variant_no = 1
                             AND v.status IN ('done','failed') AND COALESCE(v.step_at, v.created_at) < now() - interval '3 minutes'))))
         ORDER BY q.created_at LIMIT 6 FOR UPDATE SKIP LOCKED)
      RETURNING m.*`,
  );
  const runs: Promise<void>[] = [];
  for (const turn of claimed.rows) {
    if (turn.engine === "layout") {
      runs.push(
        runLayoutTurn(pool, turn.id, log).then(
          () => void planned++,
          async (e) => {
            log(`[email-layout] turn ${turn.id} failed: ${e instanceof Error ? e.message : e}`);
            await fail(pool, turn.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`);
          },
        ),
      );
      continue;
    }
    // Side by side (three directions at once), each on its own.
    runs.push(
      runPictureTurn(pool, turn, log).then(
        () => void planned++,
        async (e) => {
          const msg = e instanceof Error ? e.message : String(e);
          log(`[email-ai] turn ${turn.id} failed: ${msg}`);
          await fail(pool, turn.id, `The AI could not make this version: ${msg}`);
        },
      ),
    );
  }
  await Promise.all(runs);

  // 2a. Layout-engine banners from a batch (versions made before the switch back).
  const lb = await pool.query<{ id: string }>(`SELECT id::text FROM email_design_messages WHERE status = 'generating' AND batch_files IS NOT NULL AND engine = 'layout'`);
  for (const r of lb.rows) {
    try {
      if (await collectLayoutBatch(pool, r.id, log)) collected++;
    } catch (e) {
      log(`[email-layout] turn ${r.id} batch check failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  // 2. Batch pictures: collect what came back, then draw the next picture.
  const out = await pool.query<Msg>(`SELECT * FROM email_design_messages WHERE status = 'generating' AND batch_files IS NOT NULL AND engine = 'picture'`);
  if (!out.rows.length) return { planned, collected };
  const ai = openai();
  for (const turn of out.rows) {
    const st0 = turn.batch_files!;
    if (st0.view === "member") continue;
    // The tick runs every minute; collecting a batch (checking photos, pasting, redrawing) can take
    // longer. A batch that is already being collected is skipped, so it is never collected twice.
    if (!st0.batchId || COLLECTING.has(st0.batchId)) continue;
    COLLECTING.add(st0.batchId);
    try {
      collected += await collectOne(pool, ai, turn, st0, log);
    } finally {
      COLLECTING.delete(st0.batchId);
    }
  }
  return { planned, collected };
}

/** Batches being collected right now (one web process). */
const COLLECTING = new Set<string>();

/** Collect one finished batch of a picture turn. Returns 1 when something was collected. */
async function collectOne(pool: Pool, ai: OpenAI, turn: Msg, st0: Stage, log: (m: string) => void): Promise<number> {
  let collected = 0;
  {
    if (st0.view === "all") {
      try {
        if (await collectAll(pool, turn, st0, log)) collected++;
      } catch (e) {
        log(`[email-ai] turn ${turn.id} batch check failed: ${e instanceof Error ? e.message : e}`);
      }
      return collected;
    }
    if (st0.view === "shots") {
      try {
        const o = { designId: turn.design_id, turnId: turn.id, imageModel: turn.image_model ?? imageModel(), creativeModel: turn.creative_model?.split(" ")[0] ?? "gpt-6-astra" };
        const shots = await collectShots(o, st0, turn.shots ?? [], turn.products ?? [], log);
        if (!shots) return collected;
        turn.shots = shots;
        await pool.query(`UPDATE email_design_messages SET shots = $2, status = 'planning', batch_id = NULL, batch_files = NULL, step_at = now() WHERE id = $1::uuid`, [turn.id, JSON.stringify(shots)]);
        turn.status = "planning";
        collected++;
        await afterShots(pool, turn, log).catch(async (e) => fail(pool, turn.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`));
      } catch (e) {
        log(`[email-ai] turn ${turn.id} photo batch check failed: ${e instanceof Error ? e.message : e}`);
      }
      return collected;
    }
    const st = st0 as Extract<Stage, { view: Step }>;
    const step: Step = st.view === ("mobile" as Step) ? "mobile-bottom" : st.view;
    try {
      const b = await ai.batches.retrieve(st.batchId!);
      if (["validating", "in_progress", "finalizing", "cancelling"].includes(b.status)) return collected;
      if (b.status !== "completed" || !b.output_file_id) {
        let why = `the OpenAI batch stopped (${b.status})`;
        if (b.error_file_id) why += `: ${(await (await ai.files.content(b.error_file_id)).text()).slice(0, 300)}`;
        await fail(pool, turn.id, why);
        await cleanup(ai, st, b.output_file_id, b.error_file_id);
        return collected;
      }
      const text = await (await ai.files.content(b.output_file_id)).text();
      const line = JSON.parse(text.split("\n").find(Boolean) ?? "{}") as { response?: { body?: { data?: { b64_json?: string }[]; error?: { message?: string } } }; error?: { message?: string } };
      const b64 = line.response?.body?.data?.[0]?.b64_json;
      await cleanup(ai, st, b.output_file_id, b.error_file_id);
      if (!b64) {
        await fail(pool, turn.id, `No ${step} picture came back: ${line.response?.body?.error?.message ?? line.error?.message ?? "unknown reason"}`);
        return collected;
      }
      // A picture from before the phone was drawn in two parts is the whole phone view.
      const saved =
        st.view === ("mobile" as Step)
          ? await (async () => {
              const path = `email/designs/${turn.design_id}/${turn.id}-mobile.png`;
              await uploadBytesToStorage({ path, bytes: await sharp(Buffer.from(b64, "base64")).png().toBuffer(), contentType: "image/png" });
              return { column: "mobile_path" as const, path };
            })()
          : await savePicture(pool, turn, step, b64);
      await pool.query(`UPDATE email_design_messages SET ${saved.column} = $2, status = 'planning', batch_id = NULL, batch_files = NULL WHERE id = $1::uuid`, [turn.id, saved.path]);
      setPath(turn, saved.column, saved.path);
      collected++;
      try {
        await drawNext(pool, turn, log);
      } catch (e) {
        await fail(pool, turn.id, `The AI could not make the next picture: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      log(`[email-ai] turn ${turn.id} check failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return collected;
}

/* ------------------------------------------------- layout engine (2026-11-08) */

async function loadLayoutTurn(pool: Pool, id: string): Promise<LayoutTurn> {
  const r = await pool.query<LayoutTurn>(
    `SELECT m.id::text, m.design_id::text, d.tenant_id::text, m.text, m.target, m.mode, m.status, m.products, m.media, m.draft_html, m.banners,
            m.direction, m.variant_group::text, m.variant_no, m.batch_files, m.created_at
       FROM email_design_messages m JOIN email_designs d ON d.id = m.design_id WHERE m.id = $1::uuid`,
    [id],
  );
  if (!r.rows[0]) throw new Error("turn not found");
  return r.rows[0];
}

/** A layout turn still queued from before the switch back: finish it the layout way. */
async function runLayoutTurn(pool: Pool, id: string, log: (m: string) => void): Promise<void> {
  const turn = await loadLayoutTurn(pool, id);
  const p = await planLayout(pool, turn);
  await pool.query(
    `UPDATE email_design_messages SET text = $2, draft_html = $3, products = $4, media = $5, banners = $6, direction = $7 WHERE id = $1::uuid AND status = 'planning'`,
    [turn.id, p.reply, p.html, JSON.stringify(p.products), JSON.stringify(p.media), JSON.stringify(p.banners), p.direction],
  );
  Object.assign(turn, { draft_html: p.html, products: p.products, media: p.media, banners: p.banners, direction: p.direction });
  const toDraw = p.banners.filter((b) => !b.url);
  if (toDraw.length && turn.mode !== "fast") {
    const st = await submitBanners(pool, turn);
    if (st) {
      await pool.query(`UPDATE email_design_messages SET status = 'generating', batch_id = $2, batch_files = $3 WHERE id = $1::uuid AND status = 'planning'`, [turn.id, st.batchId, JSON.stringify(st)]);
      return;
    }
  }
  const banners = toDraw.length ? await drawBannersFast(pool, turn, log) : p.banners;
  await finishLayoutTurn(pool, turn, banners, log);
}

async function collectLayoutBatch(pool: Pool, id: string, log: (m: string) => void): Promise<boolean> {
  const turn = await loadLayoutTurn(pool, id);
  if (turn.status !== "generating" || !turn.batch_files) return false;
  const banners = await collectBanners(pool, turn, log);
  if (!banners) return false;
  await finishLayoutTurn(pool, turn, banners, log);
  return true;
}

async function finishLayoutTurn(pool: Pool, turn: LayoutTurn, banners: Banner[], log: (m: string) => void): Promise<void> {
  turn.banners = banners;
  const { html, missing } = await renderLayout(pool, turn, turn.draft_html ?? "");
  const failed = banners.filter((b) => !b.url).map((b) => `${b.id}: ${b.error ?? "not drawn"}`);
  const note = failed.length ? `Some banners could not be made and were left out (${failed.join("; ")}).` : missing.length ? `Left out pictures that could not be loaded: ${missing.join(", ")}.` : null;
  const r = await pool.query(
    `UPDATE email_design_messages SET status = 'done', html = $2, banners = $3, error = $4, finished_at = now(), batch_id = NULL, batch_files = NULL
      WHERE id = $1::uuid AND status IN ('planning','generating')`,
    [turn.id, html, JSON.stringify(banners), note],
  );
  if (r.rowCount) await pool.query(`UPDATE email_designs SET updated_at = now() WHERE id = $1::uuid`, [turn.design_id]);
  log(`[email-layout] turn ${turn.id}: done (${banners.length} banner(s))`);
}

export type { LayoutStage };

/* -------------------------------------------------------------- voice input */

export async function transcribe(audio: Buffer, mime: string, name: string): Promise<string> {
  const r = await openai().audio.transcriptions.create({
    model: transcribeModel(),
    file: await toFile(audio, name, { type: mime }),
    prompt: "An owner of the fashion store CARBON describes a marketing email: headings, photos, buttons, colours, discount codes.",
  });
  return (r.text ?? "").trim();
}
