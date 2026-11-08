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
 * One turn:
 *  1. PLAN (live): the text model reads the chat, the current pictures, the
 *     in-stock catalog (matching sets as one card), CARBON's pictures, the
 *     store facts and the current Instagram campaign look, picks the products
 *     and pictures, and writes one picture brief per view;
 *  2. REVIEW (when "approve the items first" is on): the turn stops at
 *     'review'; the owner removes, swaps or adds items and approves. If the
 *     items changed, the briefs are rewritten around exactly those items;
 *  3. PICTURES (Batch or Fast): desktop, then the phone top part made from the
 *     desktop, then the phone bottom part continuing it.
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
import { DESKTOP_SIZE, MOBILE_SIZE, imageModel, openai, textModel, transcribeModel } from "./config";
import { catalogLines, catalogSets, inStockCatalog, logoReference, productGallery, referencePhoto, type CatalogProduct, type CatalogSet } from "./catalog";
import { STORE_TEXT, mediaLibrary, mediaLines, mediaPhoto, type MediaItem, type TurnMedia } from "./brand";
import { styleGuide, styleRefs, styleText } from "./style";
import { DIRECTIONS, collectBanners, drawBannersFast, planLayout, renderLayout, submitBanners, type Banner, type LayoutStage, type LayoutTurn } from "./layout";

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
  concept: string | null;
  created_at: Date;
};

/** Where a turn's pictures are: which step is being drawn and which OpenAI files to clean up. */
type Stage = { view: Step; batchId?: string; inputFileId?: string; refFileIds?: string[] };

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

const COMMON_RULES = `Put the official CARBON logo (from its reference picture, exactly as given) where the brief places it (the top, unless told otherwise). Typography must be crisp and perfectly spelled, exactly the words given. Personal parts use sample values: the customer's first name is "${SAMPLE_NAME}" and a personal discount code (when there is one) is "${SAMPLE_CODE}" shown in a clearly separate box. Buttons are solid rectangles with their label inside. Leave out any unsubscribe line, legal footer or postal address (added automatically later). Nothing may be cut off at the edges.
CLOTHES: every garment and shoe is exactly the real product in its catalog photos — same type, cut, colour, wash, prints, stitching, hardware and any CARBON lettering; where a side is not visible in the photos, keep it plain. NEVER add another brand's logo, swoosh, stripes, monogram or wordmark to anything.
REAL PHOTOS: a product tile shows the catalog photo as it is; a store or brand photo is reproduced as faithfully as possible (people, clothes, signs and place unchanged; only cropped to fit). They are swapped for the real files when the email is converted. Generated photos (new models, any location) are only for banners and lifestyle shots.`;

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
  for (let i = 1; i <= n; i++) {
    const a = await pool.query<{ id: string }>(
      `INSERT INTO email_design_messages (design_id, role, target, mode, status, engine, variant_group, variant_no, fresh, needs_review, created_at)
       VALUES ($1::uuid, 'ai', $2, $3, 'queued', 'picture', $4::uuid, $5, $6, $7, now() + ($8 || ' milliseconds')::interval) RETURNING id`,
      [input.designId, target, input.mode, group, group ? i : null, group ? true : null, input.review !== false, String(i)],
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
  return `You are the creative director and email designer inside CarbonWMS, working for the owner of CARBON.
${BRAND}

${style}

The owner describes an email (or changes to it) in a chat. Each version is DRAWN as pictures at the real size a customer sees: a DESKTOP picture (the 600 px email column, about 1,790 px tall) and a PHONE picture (375 px wide) made of a TOP part and a BOTTOM part (each about 1,115 phone px tall). The owner's message says which view(s) to change: "both", "desktop" or "mobile".

Write JSON with:
- reply: 1–3 short plain sentences to the owner about what you chose / are drawing (no em dashes, no hype). If something is impossible or unclear, say so and make your best version anyway.
- title: a 2–5 word name for this email (first turn only, otherwise null).
- subject: subject line (max 60 characters, may use {{first_name}}), or null to keep the previous one.
- preheader: inbox preview text (max 90 characters), or null to keep it.
- direction: the creative direction of this version in under 12 words.
- layout: "new" or "edit". "new" when there is no version yet, or the owner asks for a different / more creative / new layout or look: then design from a blank page in a direction clearly DIFFERENT from every earlier direction listed (different structure, rhythm, colour use, typography — not the same sections re-skinned). "edit" for changes to the current version: change what was asked and carry over everything else exactly.
- desktop_prompt: when the desktop view changes, a complete, self-contained brief of the WHOLE desktop email from top to bottom: every section in order, the exact words of every heading, paragraph, price and button, every photo (which catalog / brand / attached photo, or what a generated banner shows: models, look, location, light), colours, type style, alignment, spacing, sizes in EMAIL pixels. Never write "same as before". Null when the desktop does not change.
- mobile_top / mobile_bottom: when the phone view changes, the same for the phone layout (stacked blocks, full-width buttons), split into the TOP part (from the top to a clean section break about 1,115 phone px down) and the BOTTOM part (the rest, to the end). Both null when the phone view does not change.
- products: every catalog product shown, as refs ["P12","X3",…] (a set X-ref = the whole set; at most ${MAX_PRODUCTS} pieces), or null to keep the previous version's products.
- media: CARBON pictures used, as refs ["S1","M7"] (at most ${MAX_MEDIA}), or null to keep the previous ones.

CREATIVE RULES:
- Be a top fashion creative. Build complete outfits (top + bottom + outer layer + shoes + accessory where the catalog has them), styled by season and the owner's ask, from real in-stock catalog products only (prefer stock 3+). Never invent garments.
- Make the layout earn attention: strong rhythm, big/small contrast, real graphic ideas from the campaign look. Do not fall back on the same pattern every time (logo, nav, big photo, heading, button, two cards, black code panel, footer) unless the owner asks for it.
- When the owner asks for MORE items, ADD them to what is there (never swap the existing ones out unless asked).
- Product names and prices shown must be exactly the catalog's.
- MATCHING SETS (X-refs, listed after the catalog) are shown exactly like the store's homepage set card: ONE card per set, never as separate products with separate prices. Top to bottom: the set's photo (the model wears the whole set, from the set's top piece photo) with a small black label in its top-left corner, white bold uppercase letter-spaced "2-PIECE SET" (or "3-PIECE SET"); a tiny grey uppercase "CARBON"; the set name in bold uppercase ("COLE SET"); the pieces line in small grey text exactly as given ("Top $67.00 + Pants $65.00"); the total in bold, "Set $132.00". A look that uses a set lists it as one line ("Cole Set — Set $132.00"), then the look's other pieces.
- In the briefs refer to products as "catalog photo of P12 (<name>)" and to CARBON pictures as "brand photo S1 (<short description>)"; the picture model receives those real photos. Product tiles show the catalog photo as it is.
- When the email mentions the store, a visit, hours or directions, use the exact store facts and the real store photos (S1 outside, S2 inside); "Get directions" goes to Google Maps. Never invent a store picture.
- Generated pictures (banners, lifestyle shots) show NEW models (any look, hair, make-up) wearing the chosen real products, in a location that fits the season and the campaign look.
- The official logo is always supplied; say where it sits, never how to draw it.
- Personal parts: the customer's first name appears as "${SAMPLE_NAME}", a personal code as "${SAMPLE_CODE}". No unsubscribe line or postal address (added automatically).

Ideas for directions (use, mix or go beyond):
${DIRECTIONS.map((d, i) => `${i + 1}. ${d}`).join("\n")}`;
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
  const variant = turn.variant_no
    ? `\n\nTHIS IS DIRECTION ${turn.variant_no} OF 3 for the owner's last message: layout "new", in this direction: ${DIRECTIONS[(hash(turn.variant_group ?? "") + turn.variant_no * 5) % DIRECTIONS.length]}. The other two directions are made separately and will look completely different.`
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

  if (locked) {
    content.push({
      type: "text",
      text:
        `THE ITEMS ARE FIXED (approved by the owner). Use EXACTLY these, all of them where they fit, and nothing else from the catalog:\n` +
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
  const top = str(j.mobile_top, 8000);
  const bottom = str(j.mobile_bottom, 8000);
  const desktop = str(j.desktop_prompt, 8000);
  const products = locked
    ? locked.products
    : Array.isArray(j.products)
      ? turnProducts((j.products as unknown[]).map(String), catalog, sets)
      : (base?.products ?? []);
  const media = locked
    ? locked.media
    : Array.isArray(j.media)
      ? (j.media as unknown[])
          .map((r) => library.find((m) => m.ref === String(r).trim().toUpperCase()))
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
    if (!turn.mobile_top_path) throw new Error("the phone top part is missing");
    images.push(await load(turn.mobile_top_path));
    labels.push("the TOP PART of this phone email, already finished: continue exactly below it");
    lead = "Draw the BOTTOM PART of the phone email whose top part is image 1.";
    if (desktopNow) {
      images.push(await load(desktopNow));
      labels.push("the finished DESKTOP version of this email (the same content)");
    }
    if (prev?.mobile_path && !fresh) {
      images.push(await half(prev.mobile_path, "bottom"));
      labels.push("the previous phone version's bottom part (layout guide)");
    }
  }
  images.push(await logoReference());
  labels.push("the official CARBON logo (reference only: copy it exactly)");
  for (const [i, a] of atts.entries()) {
    if (images.length >= MAX_REFS - 2) break;
    images.push(await load(a.path));
    labels.push(`attached photo ${i + 1} (${a.name})`);
  }
  // Every product's main photo first, then extra angles (side, back, details) while there is room.
  const products = turn.products ?? [];
  const gallery = await productGallery(products.map((p) => p.id), 3).catch(() => new Map<string, string[]>());
  for (let angle = 0; angle < 3; angle++) {
    for (const p of products) {
      if (images.length >= MAX_REFS - 1) break;
      const urls = gallery.get(p.id) ?? (p.image ? [p.image] : []);
      const u = urls[angle];
      if (!u) continue;
      const b = await referencePhoto(u);
      if (!b) continue;
      images.push(b);
      labels.push(`catalog photo of ${p.title}${angle ? ` (another angle)` : ""}: the real product, keep it exactly${p.set ? ` (piece of ${p.set.name})` : ""}`);
    }
  }
  for (const m of (turn.media ?? []).slice(0, MAX_MEDIA)) {
    if (images.length >= MAX_REFS) break;
    const b = await mediaPhoto(m);
    if (!b) continue;
    images.push(b);
    labels.push(`brand photo (${m.description.slice(0, 120)}): CARBON's own picture, reproduce it faithfully where the brief places it (crop to fit only)`);
  }
  const style = await styleGuide(pool, await tenantOf(pool, turn.design_id));
  for (const s of await styleRefs(style, 1)) {
    if (images.length >= MAX_REFS) break;
    images.push(s);
    labels.push("CARBON's Instagram campaign picture: STYLE reference only (light, colour grade, graphic feel); do not copy its people or clothes");
  }
  const brief = step === "desktop" ? (turn.desktop_prompt ?? "") : (turn.mobile_prompt ?? "").split(BOTTOM_MARK)[step === "mobile-top" ? 0 : 1] ?? "";
  const legend = `\n\nThe input images, in order:\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}`;
  const styleLine = style?.guide ? `Campaign look: ${style.guide.summary} Palette ${style.guide.palette.join(", ")}. ${style.guide.typography}` : "";
  return { prompt: pictureFrame(step, brief, lead, styleLine) + legend, size: sizeOf(step), images };
}

async function toPng(b: Buffer): Promise<Buffer> {
  return sharp(b).rotate().png({ compressionLevel: 9 }).toBuffer();
}

/** Save a drawn picture; the phone bottom part is joined under the top part into one phone picture. */
async function savePicture(turn: Msg, step: Step, b64: string): Promise<{ column: "desktop_path" | "mobile_top_path" | "mobile_path"; path: string }> {
  const png = await sharp(Buffer.from(b64, "base64")).png({ compressionLevel: 9 }).toBuffer();
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

async function drawFast(inputs: Inputs): Promise<string> {
  const ai = openai();
  const common = { model: imageModel(), prompt: inputs.prompt, size: inputs.size as "1024x1536", quality: "high" as const, n: 1 };
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
      model: imageModel(),
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
  for (const f of [st?.inputFileId, ...(st?.refFileIds ?? []), ...more]) if (f) await ai.files.delete(f).catch(() => {});
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
      const b64 = await drawFast(inputs);
      const saved = await savePicture(turn, step, b64);
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

/** The owner's approved items: products (ids; a set piece brings its set) and CARBON pictures (ids). */
export async function approveItems(pool: Pool, designId: string, messageId: string, productIds: string[], mediaIds: string[]): Promise<void> {
  const r = await pool.query<{ variant_group: string | null; products: TurnProduct[] | null; media: TurnMedia[] | null }>(
    `SELECT variant_group::text, products, media FROM email_design_messages WHERE id = $1::uuid AND design_id = $2::uuid AND role = 'ai' AND status = 'review'`,
    [messageId, designId],
  );
  const row = r.rows[0];
  if (!row) throw new Error("This version is not waiting for approval");
  const catalog = await inStockCatalog().catch(() => [] as CatalogProduct[]);
  const sets = catalogSets(catalog);
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
  const ids = row.variant_group
    ? (await pool.query<{ id: string }>(`SELECT id::text FROM email_design_messages WHERE variant_group = $1::uuid AND status IN ('review','queued')`, [row.variant_group])).rows.map((x) => x.id)
    : [messageId];
  await pool.query(
    `UPDATE email_design_messages SET products = $2, media = $3, needs_review = false,
            status = CASE WHEN id = $4::uuid THEN 'approved' ELSE status END,
            desktop_prompt = CASE WHEN $5 AND id = $4::uuid THEN desktop_prompt ELSE NULL END,
            mobile_prompt = CASE WHEN $5 AND id = $4::uuid THEN mobile_prompt ELSE NULL END
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
      WHERE id = $1::uuid AND status IN ('planning')`,
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
async function runPictureTurn(pool: Pool, turn: Msg, log: (m: string) => void): Promise<void> {
  if (!(await planPictureTurn(pool, turn, log))) return;
  // Direction 1 has its items: start directions 2 and 3 right now (not on the next tick), plan them side by
  // side, then all three draw at the same time (owner, 2026-11-08: "why doesn't it generate all 3 at once?").
  if (turn.variant_group && turn.variant_no === 1) {
    const sibs = await pool.query<Msg>(
      `UPDATE email_design_messages SET status = 'planning', step_at = now() WHERE variant_group = $1::uuid AND variant_no > 1 AND status = 'queued' RETURNING *`,
      [turn.variant_group],
    );
    const ready = await Promise.all(
      sibs.rows.map((s) =>
        planPictureTurn(pool, s, log).then(
          (ok) => (ok ? s : null),
          async (e) => {
            await fail(pool, s.id, `The AI could not make this version: ${e instanceof Error ? e.message : String(e)}`);
            return null;
          },
        ),
      ),
    );
    await Promise.all(
      [turn, ...ready.filter((s): s is Msg => !!s)].map((t) =>
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
  const approvedAlready = turn.status === "approved-planning";
  const locked = turn.products && (approvedAlready || (turn.variant_no ?? 0) > 1) ? { products: turn.products, media: turn.media ?? [] } : null;
  // An approved turn whose items did not change keeps its briefs.
  if (approvedAlready && (turn.desktop_prompt || turn.mobile_prompt)) return true;
  await pool.query(`UPDATE email_design_messages SET status = 'planning' WHERE id = $1::uuid`, [turn.id]);
  const p = await plan(pool, turn, locked);
  const review = !!turn.needs_review && !locked && (!turn.variant_no || turn.variant_no === 1);
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
                             AND v.status IN ('generating','done','failed') AND COALESCE(v.step_at, v.created_at) < now() - interval '3 minutes'))))
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
    const st = turn.batch_files!;
    const step: Step = st.view === ("mobile" as Step) ? "mobile-bottom" : st.view;
    try {
      const b = await ai.batches.retrieve(st.batchId!);
      if (["validating", "in_progress", "finalizing", "cancelling"].includes(b.status)) continue;
      if (b.status !== "completed" || !b.output_file_id) {
        let why = `the OpenAI batch stopped (${b.status})`;
        if (b.error_file_id) why += `: ${(await (await ai.files.content(b.error_file_id)).text()).slice(0, 300)}`;
        await fail(pool, turn.id, why);
        await cleanup(ai, st, b.output_file_id, b.error_file_id);
        continue;
      }
      const text = await (await ai.files.content(b.output_file_id)).text();
      const line = JSON.parse(text.split("\n").find(Boolean) ?? "{}") as { response?: { body?: { data?: { b64_json?: string }[]; error?: { message?: string } } }; error?: { message?: string } };
      const b64 = line.response?.body?.data?.[0]?.b64_json;
      await cleanup(ai, st, b.output_file_id, b.error_file_id);
      if (!b64) {
        await fail(pool, turn.id, `No ${step} picture came back: ${line.response?.body?.error?.message ?? line.error?.message ?? "unknown reason"}`);
        continue;
      }
      // A picture from before the phone was drawn in two parts is the whole phone view.
      const saved =
        st.view === ("mobile" as Step)
          ? await (async () => {
              const path = `email/designs/${turn.design_id}/${turn.id}-mobile.png`;
              await uploadBytesToStorage({ path, bytes: await sharp(Buffer.from(b64, "base64")).png().toBuffer(), contentType: "image/png" });
              return { column: "mobile_path" as const, path };
            })()
          : await savePicture(turn, step, b64);
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
  return { planned, collected };
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
