/**
 * CarbonWMS Email — AI Designer, LAYOUT ENGINE (owner, 2026-11-08).
 *
 * Why: the first engine drew the WHOLE email as one picture, so the picture
 * model redrew everything — the store photos ("6250 / 6260"), the product
 * photos (new faces), and guessed what it could not see (a Nike swoosh on the
 * real Carbon Sneakers, whose photo shows only the top). No prompt can stop a
 * picture model from redrawing what it is given.
 *
 * Now a version is a real email layout:
 *  1. PLAN (live): the text model writes the email as HTML with slots —
 *       {{img:P12}} a product's ORIGINAL photo · {{img:S1}} a store photo ·
 *       {{img:M7}} a brand picture · {{img:A1}} a photo the owner attached ·
 *       {{img:B1}} a generated banner · {{link:P12}} a product's page ·
 *       {{logo:black}} / {{logo:white}} the official logo file
 *     (":4x5"-style suffix = crop to that shape; cropping/resizing only).
 *     It knows the in-stock catalog, the brand pictures, the store, and the
 *     look of the current Instagram campaign (style.ts).
 *  2. BANNERS (Batch or Fast): only the banners are generated, one picture
 *     each — new models, any location — dressed in the chosen real products,
 *     with every photo of each product as reference (front, side, back).
 *  3. CHECK: each banner is compared with the real product photos; a banner
 *     with another brand's logo, a changed garment or misspelt words is
 *     redrawn once with the problems listed, and anything left is shown to
 *     the owner.
 *  4. RENDER: slots are filled with hosted pictures — real photos are only
 *     cropped/resized, never changed — and the finished HTML is the version.
 *
 * Slots are stored with stable keys (product / file ids), because catalog and
 * library numbers (P12, M7) change as stock and pictures change.
 */
import sharp from "sharp";
import OpenAI, { toFile } from "openai";
import type { Pool } from "pg";
import { downloadStorageObject, uploadBytesToStorage } from "@/lib/storageProvider";
import { WMS_BASE, imageModel, openai, textModel } from "./config";
import { LOGO_URLS, catalogLines, inStockCatalog, logoReference, productGallery, referencePhoto, type CatalogProduct } from "./catalog";
import { STORE, STORE_MEDIA, STORE_TEXT, mediaLibrary, mediaLines, type MediaItem, type TurnMedia } from "./brand";
import { styleGuide, styleRefs, styleText } from "./style";
import { MERGE_TAGS, sanitizeEmailHtml } from "./rules";
import type { TurnProduct } from "./designer";

export type Banner = {
  id: string; // B1, B2 …
  view: "both" | "desktop" | "mobile";
  size: string;
  prompt: string;
  products: string[]; // product gids
  text: string | null; // words drawn on the picture (exact)
  logo: boolean;
  path?: string | null;
  url?: string | null;
  qa?: string | null; // problems still visible after the check
  error?: string | null;
};

type Attachment = { path: string; name: string };

export type LayoutTurn = {
  id: string;
  design_id: string;
  tenant_id: string;
  text: string;
  target: "both" | "desktop" | "mobile";
  mode: "batch" | "fast" | null;
  status: string;
  products: TurnProduct[] | null;
  media: TurnMedia[] | null;
  draft_html: string | null;
  banners: Banner[] | null;
  direction: string | null;
  variant_group: string | null;
  variant_no: number | null;
  batch_files: LayoutStage | null;
  created_at: Date;
};

export type LayoutStage = { kind: "banners"; batchId: string; inputFileId: string; refFileIds: string[] };

/** Sizes the picture model draws (width x height). */
const SIZES = ["1536x1024", "2048x1024", "1024x1024", "1024x1536", "1024x1792"] as const;
const MAX_PRODUCTS = 24;
const MAX_BANNERS = 5;
const MAX_REFS = 16;
const RATIOS = ["1x1", "4x5", "3x4", "2x3", "9x16", "4x3", "3x2", "16x9", "2x1", "21x9"];

/** Directions for "Show me 3 directions" and for "make it different". */
export const DIRECTIONS = [
  "MAGAZINE COVER: one huge full-bleed banner with the headline set into the picture, then a two-column editorial spread",
  "NUMBERED LOOKBOOK: LOOK 01 / 02 / 03 rows that alternate picture-left / picture-right, each with its piece list and prices",
  "AFTER DARK: the whole email on black, white type, night photography, thin white rules, one sharp accent colour",
  "STREETWEAR ZINE: ticker strips, stamps, labels, coordinates, oversized numbers, cut-out product tiles on a grid",
  "STORY SCROLL: a vertical run of tall full-width pictures like Instagram stories, a short line of copy between each",
  "COLOUR BLOCKS: alternating full-width panels in the campaign palette, product tiles sitting on the colour",
  "MOSAIC: an asymmetric collage grid mixing banners and product tiles of different sizes (1 big + 2 small, 2 + 1 …)",
  "PRICE LIST / MENU: a printed-catalogue feel, items as a numbered list with photos, thin rules, serif or condensed type",
  "THE DROP: release-style header (DROP 01, date, time), countdown-like blocks, product cards as 'pieces' in the drop",
  "PERSONAL LETTER: opens like a short note from the store to the person, then the pictures tell the rest",
  "CITY GUIDE: Orlando-led — the store, the neighbourhood, a 'where to wear it' story, directions up front",
  "QUIET LUXURY: lots of air, one picture per screen, small serif headings, very few words",
];

/* ----------------------------------------------------------------- keys */

const gnum = (gid: string) => gid.split("/").pop() ?? gid;

type Maps = {
  catalog: CatalogProduct[];
  library: MediaItem[];
  attachments: Attachment[]; // A1… in order
  refToKey: (ref: string) => string | null; // planner ref → stable key
  keyToRef: (key: string) => string | null; // stable key → current ref
};

export function buildMaps(catalog: CatalogProduct[], library: MediaItem[], attachments: Attachment[]): Maps {
  const byRef = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const p of catalog) {
    const k = `p${gnum(p.id)}`;
    byRef.set(p.ref, k);
    byKey.set(k, p.ref);
  }
  for (const m of library) {
    const k = m.kind === "store" ? m.ref.toLowerCase() : `m${gnum(m.id)}`;
    byRef.set(m.ref, k);
    byKey.set(k, m.ref);
  }
  attachments.forEach((_, i) => {
    byRef.set(`A${i + 1}`, `a${i + 1}`);
    byKey.set(`a${i + 1}`, `A${i + 1}`);
  });
  return {
    catalog,
    library,
    attachments,
    refToKey: (ref) => (/^B\d+$/i.test(ref) ? ref.toLowerCase() : (byRef.get(ref.toUpperCase()) ?? null)),
    keyToRef: (key) => (/^b\d+$/.test(key) ? key.toUpperCase() : (byKey.get(key) ?? null)),
  };
}

const SLOT = /\{\{\s*(img|link)\s*:\s*([A-Za-z0-9]+)\s*(?::\s*([0-9]+x[0-9]+))?\s*\}\}/g;

/** Planner HTML (P12, M7 …) → stored HTML (p8123…, m4662…). Unknown refs are dropped. */
export function toKeys(html: string, maps: Maps): { html: string; unknown: string[] } {
  const unknown: string[] = [];
  const out = html.replace(SLOT, (_all, kind: string, ref: string, ratio?: string) => {
    const key = maps.refToKey(ref);
    if (!key) {
      unknown.push(ref);
      return kind === "img" ? "{{img:none}}" : "{{shop_url}}";
    }
    return `{{${kind}:${key}${ratio && RATIOS.includes(ratio) ? `:${ratio}` : ""}}}`;
  });
  return { html: out, unknown };
}

/** Stored HTML → planner HTML with today's refs (products no longer in stock show as GONE). */
export function toRefs(html: string, maps: Maps): string {
  return html.replace(SLOT, (_all, kind: string, key: string, ratio?: string) => {
    const ref = maps.keyToRef(key) ?? (key.startsWith("p") ? "GONE" : key.toUpperCase());
    return `{{${kind}:${ref}${ratio ? `:${ratio}` : ""}}}`;
  });
}

/* ---------------------------------------------------------------- planner */

const LAYOUT_RULES = `HOW TO WRITE THE EMAIL (html):
- A complete HTML document. <head> holds ONE <style> block, only for @media (max-width: 620px) phone rules (classes like .m-full, .m-stack, .m-hide, .m-show, .m-pad, .m-h1, .m-center). <body> holds the email.
- Email-safe: nested tables (role="presentation"), a 600 px column centred on a full-width outer table, inline CSS on every element, no <script>, no forms, no external CSS, no web fonts, no CSS background images, no position/float/flex/grid. Font stacks only (e.g. Helvetica, Arial, sans-serif · 'Arial Narrow', Arial, sans-serif · Georgia, 'Times New Roman', serif · 'Courier New', monospace), with letter-spacing, weight and case doing the styling.
- Full-width colour (black panels, colour blocks) = background-color on table cells (bgcolor too).
- Pictures are ONLY slots: <img src="{{img:REF}}" width="…" alt="…" style="display:block;width:100%;max-width:…px;height:auto;border:0">.
    {{img:P12}} the product's ORIGINAL photo (always this for product tiles — never ask a banner to redraw a product tile)
    {{img:S1}} / {{img:S2}} the real store photos (outside / inside) — the only way to show the store
    {{img:M7}} a CARBON brand picture as it is
    {{img:A1}} a photo the owner attached
    {{img:B1}} a banner you order below (the only generated pictures)
  Add a shape to crop a real photo: {{img:S1:16x9}}, {{img:P12:4x5}} (shapes: ${RATIOS.join(", ")}). Cropping and resizing are the only changes ever made to real photos.
- Links: product pictures/names link to {{link:P12}}; the main shop button to {{code_url}} when there is a personal code, else {{shop_url}}; Instagram {{instagram_url}}; store page ${STORE.locatorUrl}; "Get directions" ${STORE.directionsUrl}.
- Logo: <img src="{{logo:black}}"> on light backgrounds, <img src="{{logo:white}}"> on dark ones (the file is 1200x358; show it 120-200 px wide). Never type CARBON as a logo, never redraw it.
- Merge tags for the person: ${MERGE_TAGS.map((t) => `{{${t}}}`).join(" ")}. Greet with {{greeting_name}}; show a personal code as {{code}} in a clear code box; the offer as {{offer_amount}} (e.g. "$20" or "10%") and its end as {{offer_ends}} — never write the offer's number yourself.
- Leave out the unsubscribe line, legal footer and postal address (added automatically below your email).
- Buttons: a table cell with background colour and an <a> inside, at least 44 px tall.
- Phone: the same email re-flowed by the @media rules (stack columns with .m-stack, full-width buttons, bigger text). A phone-only picture or block: wrap it in a <div class="m-show" style="display:none;max-height:0;overflow:hidden;mso-hide:all"> and give .m-show {display:block !important;max-height:none !important;overflow:visible !important}; hide desktop-only blocks on phones with .m-hide {display:none !important}.`;

const BANNER_RULES = `BANNERS (generated pictures, at most ${MAX_BANNERS}):
- For each {{img:B#}} you use, order it in "banners": {"id":"B1","view":"both|desktop|mobile","size":one of ${SIZES.join(" ")},"products":["P12",…] (the real products the people wear, at most 6),"text":"exact words drawn on the picture, or null","logo":false,"prompt":"…","keep":false}.
- prompt = a photographer's brief: who (new models: age, look, hair, make-up, how many), what each wears (name the products), where (any location that fits the season and the campaign look: streets, rooftops, parking decks, waterfront, studio…), light, time of day, camera, pose, mood, composition and where empty space is left for any words.
- The real products are given to the picture model as photos; the garments and shoes must look exactly like them. Never ask for other brands.
- Words drawn on a banner ("text") are allowed for big graphic headlines only: short, exact, and repeated in the alt text. Everything else is live HTML text.
- keep:true re-uses the previous version's banner with the same id unchanged (when nothing about it changes) — then prompt can be "".
- Use a phone-only banner (view "mobile", tall size) only when a wide banner would be too small on a phone.`;

function plannerSystem(styleBlock: string): string {
  return `You are the creative director and email designer inside CarbonWMS, working for the owner of CARBON, an Orlando fashion store (store + shopcarbon.com): streetwear, denim and going-out looks for men and women.
Never mention other brands, never invent prices, discounts or dates the owner did not give, never write "Carbon Jeans".
${STORE_TEXT}

${styleBlock}

The owner describes an email (or changes to it) in a chat. You answer with a full email layout as real HTML plus orders for generated banners.

Write JSON:
{"reply": "1-3 short plain sentences to the owner: what you made / changed (no hype, no em dashes). If something is impossible, say so.",
 "title": "2-5 word name (first turn only, else null)",
 "subject": "subject line, max 60 chars, may use {{first_name}}; null = keep",
 "preheader": "inbox preview text, max 90 chars; null = keep",
 "direction": "the creative direction of this version in under 12 words",
 "layout": "new" or "edit",
 "products": ["P12", …] every catalog product shown anywhere (at most ${MAX_PRODUCTS}),
 "media": ["S1","M7", …] every brand picture used,
 "banners": [ … ],
 "html": "the complete email"}

CREATIVE RULES:
- Be a top fashion creative. Build complete outfits (top + bottom + outer layer + shoes + accessory where the catalog has them), styled by season and the owner's ask, from real in-stock catalog products only (prefer stock 3+). Never invent garments.
- Product names and prices shown must be exactly the catalog's.
- Make the layout earn attention: strong rhythm, contrast between big and small, real graphic ideas from the campaign look. Do not fall back on: logo, nav, big photo, heading, button, two cards, black code panel, footer — unless the owner asks for exactly that.
- "layout":"new" when there is no version yet, or the owner asks for a different / more creative / new layout or look: then design from a blank page in a direction clearly DIFFERENT from every earlier direction listed — different structure, rhythm, colour use and typography, not the same sections re-skinned.
- "layout":"edit" for changes to the current version: change what was asked, keep everything else in the html exactly as it is (copy it), keep:true on banners that do not change.
- When the owner asks for MORE items, ADD them to what is there (never swap the existing ones out unless asked).
- The owner chooses which view a message changes: "both", "desktop" (change the desktop layout, keep how the phone looks) or "mobile" (change only the phone layout: the @media rules and phone-only blocks).

${LAYOUT_RULES}

${BANNER_RULES}

Some ideas for directions (use, mix or go beyond):
${DIRECTIONS.map((d, i) => `${i + 1}. ${d}`).join("\n")}`;
}

type PlanOut = {
  reply: string;
  title: string | null;
  subject: string | null;
  preheader: string | null;
  direction: string | null;
  html: string;
  products: TurnProduct[];
  media: TurnMedia[];
  banners: Banner[];
  unknown: string[];
};

type Base = { id: string; engine: string; draft_html: string | null; banners: Banner[] | null; products: TurnProduct[] | null; media: TurnMedia[] | null; desktop_path: string | null; mobile_path: string | null; direction: string | null };

/** The version this turn builds on: the newest finished one (a picked direction, or no group). */
export async function baseVersion(pool: Pool, designId: string, before: Date): Promise<Base | null> {
  const r = await pool.query<Base>(
    `SELECT id::text, engine, draft_html, banners, products, media, desktop_path, mobile_path, direction FROM email_design_messages
      WHERE design_id = $1::uuid AND role = 'ai' AND status = 'done' AND created_at < $2 AND (variant_group IS NULL OR picked IS TRUE)
      ORDER BY created_at DESC LIMIT 1`,
    [designId, before],
  );
  return r.rows[0] ?? null;
}

async function asDataUrl(path: string, maxW = 900): Promise<string> {
  const obj = await downloadStorageObject(path);
  const jpg = await sharp(Buffer.from(obj.body)).rotate().resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}

export async function planLayout(pool: Pool, turn: LayoutTurn): Promise<PlanOut> {
  const history = await pool.query<{ role: string; text: string; target: string; attachments: Attachment[] | null; direction: string | null }>(
    `SELECT role, text, target, attachments, direction FROM email_design_messages
      WHERE design_id = $1::uuid AND created_at < $2 AND (role = 'owner' OR (status = 'done' AND (variant_group IS NULL OR picked IS TRUE)))
      ORDER BY created_at`,
    [turn.design_id, turn.created_at],
  );
  const attachments = history.rows.filter((h) => h.role === "owner").flatMap((h) => h.attachments ?? []);
  const [catalog, library, style] = await Promise.all([
    inStockCatalog().catch((e) => {
      console.warn("[email-layout] catalog unavailable:", e instanceof Error ? e.message : e);
      return [] as CatalogProduct[];
    }),
    mediaLibrary(pool),
    styleGuide(pool, turn.tenant_id),
  ]);
  const maps = buildMaps(catalog, library, attachments);
  const base = await baseVersion(pool, turn.design_id, turn.created_at);
  const earlier = [...new Set(history.rows.map((h) => h.direction).filter((d): d is string => !!d))];

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  content.push({
    type: "text",
    text:
      `Conversation so far:\n${history.rows.map((h) => (h.role === "owner" ? `OWNER (changes: ${h.target}): ${h.text}` : `YOU: ${h.text}`)).join("\n")}\n\n` +
      `This turn changes: ${turn.target}.` +
      (earlier.length ? `\nEarlier directions (a new layout must differ from all of them): ${earlier.join(" | ")}` : "") +
      (turn.variant_no
        ? `\n\nTHIS IS DIRECTION ${turn.variant_no} OF 3 for the owner's last message: make a "new" layout in this direction: ${DIRECTIONS[(hash(turn.variant_group ?? "") + turn.variant_no * 5) % DIRECTIONS.length]}. The other two directions are made separately and will look completely different.`
        : ""),
  });
  if (base?.engine === "layout" && base.draft_html) {
    const kept = (base.banners ?? []).map((b) => `${b.id} (${b.view}, ${b.size}${b.text ? `, words "${b.text}"` : ""}): ${b.prompt.slice(0, 300)}`).join("\n");
    content.push({ type: "text", text: `THE CURRENT VERSION (direction: ${base.direction ?? "-"}):\nBanners:\n${kept || "(none)"}\n\nHTML:\n${toRefs(base.draft_html, maps)}` });
  } else if (base?.desktop_path) {
    content.push({ type: "text", text: "The current version is an older drawn design (pictures follow: desktop, then phone). Rebuild it as a real layout, keeping what the owner liked unless they ask otherwise." });
    content.push({ type: "image_url", image_url: { url: await asDataUrl(base.desktop_path), detail: "low" } });
    if (base.mobile_path) content.push({ type: "image_url", image_url: { url: await asDataUrl(base.mobile_path), detail: "low" } });
  } else {
    content.push({ type: "text", text: "There is no version yet: this is the first one (layout \"new\")." });
  }
  content.push({
    type: "text",
    text: catalog.length
      ? `CATALOG (${catalog.length} products in stock) — ref | name | type | men/women | colours | price | stock:\n${catalogLines(catalog)}`
      : "The catalog could not be read right now: do not show specific products.",
  });
  content.push({ type: "text", text: `BRAND PICTURES — ref | kind | shape | description (S1/S2 are the real store photos):\n${mediaLines(library)}` });
  for (const [i, a] of attachments.entries()) {
    content.push({ type: "text", text: `Attached photo A${i + 1} (${a.name}) — use it as {{img:A${i + 1}}}:` });
    content.push({ type: "image_url", image_url: { url: await asDataUrl(a.path, 640), detail: "low" } });
  }

  const c = await openai().chat.completions.create({
    model: textModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: plannerSystem(styleText(style?.guide)) },
      { role: "user", content },
    ],
  });
  const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
  const rawHtml = String(j.html ?? "");
  if (rawHtml.length < 200 || !/<table/i.test(rawHtml)) throw new Error("The AI did not write an email layout; send the message again");
  const { html, unknown } = toKeys(rawHtml, maps);

  // Products: the ones listed + any used in the html; at most MAX_PRODUCTS.
  const refsUsed = [...rawHtml.matchAll(SLOT)].map((m) => m[2].toUpperCase());
  const wantRefs = [...new Set([...(Array.isArray(j.products) ? (j.products as unknown[]).map((x) => String(x).trim().toUpperCase()) : []), ...refsUsed.filter((r) => /^P\d+$/.test(r))])];
  const products = wantRefs
    .map((r) => catalog.find((p) => p.ref === r))
    .filter((p): p is CatalogProduct => !!p)
    .slice(0, MAX_PRODUCTS)
    .map((p) => ({ id: p.id, title: p.title, url: p.url, price: p.price, image: p.image }));
  // Keep products of the previous version that the edited html still shows but are no longer in the catalog list.
  for (const p of base?.products ?? []) if (!products.some((x) => x.id === p.id) && html.includes(`p${gnum(p.id)}`)) products.push(p);
  const mediaRefs = [...new Set([...(Array.isArray(j.media) ? (j.media as unknown[]).map((x) => String(x).trim().toUpperCase()) : []), ...refsUsed.filter((r) => /^[SM]\d+$/.test(r))])];
  const media = mediaRefs
    .map((r) => library.find((m) => m.ref === r))
    .filter((m): m is MediaItem => !!m)
    .map((m) => ({ id: m.id, url: m.url, width: m.width, height: m.height, kind: m.kind, description: m.description }));

  const prevBanners = new Map((base?.engine === "layout" ? (base.banners ?? []) : []).map((b) => [b.id.toUpperCase(), b]));
  const banners: Banner[] = [];
  for (const raw of (Array.isArray(j.banners) ? (j.banners as Record<string, unknown>[]) : []).slice(0, MAX_BANNERS)) {
    const id = String(raw.id ?? "").trim().toUpperCase();
    if (!/^B\d+$/.test(id) || banners.some((b) => b.id === id)) continue;
    const prev = prevBanners.get(id);
    if (raw.keep === true && prev?.url) {
      banners.push({ ...prev, id });
      continue;
    }
    const size = SIZES.includes(String(raw.size) as (typeof SIZES)[number]) ? String(raw.size) : "1536x1024";
    const view = raw.view === "desktop" || raw.view === "mobile" ? raw.view : "both";
    const prods = (Array.isArray(raw.products) ? (raw.products as unknown[]) : [])
      .map((r) => catalog.find((p) => p.ref === String(r).trim().toUpperCase())?.id)
      .filter((x): x is string => !!x)
      .slice(0, 6);
    const text = raw.text ? String(raw.text).slice(0, 80) : null;
    banners.push({ id, view, size, prompt: String(raw.prompt ?? "").slice(0, 4000), products: prods, text, logo: raw.logo === true, path: null, url: null, qa: null });
  }
  // Every banner slot in the html must have an order (else the slot is removed at render).
  const str = (v: unknown, n: number) => (v ? String(v).slice(0, n) : null);
  return {
    reply: String(j.reply ?? "Here is the new version.").slice(0, 1200),
    title: str(j.title, 80),
    subject: str(j.subject, 120),
    preheader: str(j.preheader, 200),
    direction: str(j.direction, 160),
    html,
    products,
    media,
    banners,
    unknown,
  };
}

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/* ----------------------------------------------------------------- banners */

async function bannerInputs(b: Banner, turn: LayoutTurn, styleImgs: Buffer[]): Promise<{ prompt: string; images: Buffer[] }> {
  const gallery = await productGallery(b.products, 4).catch(() => new Map<string, string[]>());
  const byId = new Map((turn.products ?? []).map((p) => [p.id, p]));
  const images: Buffer[] = [];
  const labels: string[] = [];
  for (const pid of b.products) {
    const p = byId.get(pid);
    const urls = gallery.get(pid) ?? (p?.image ? [p.image] : []);
    let n = 0;
    for (const u of urls) {
      if (images.length >= MAX_REFS - (b.logo ? 1 : 0) - 1) break;
      const img = await referencePhoto(u);
      if (!img) continue;
      images.push(img);
      labels.push(`real product "${p?.title ?? "item"}" (photo ${++n}: front, side, back or detail)`);
    }
  }
  for (const s of styleImgs) {
    if (images.length >= MAX_REFS - (b.logo ? 1 : 0)) break;
    images.push(s);
    labels.push("CARBON's Instagram campaign picture: STYLE reference only (light, colour grade, mood, graphic feel); do not copy its people or clothes");
  }
  if (b.logo) {
    images.push(await logoReference());
    labels.push("the official CARBON logo (copy exactly, only if the brief places it)");
  }
  const prompt = [
    `A fashion campaign photograph for CARBON (Orlando streetwear and going-out store), to be used as an email banner, ${b.size.replace("x", " x ")} px.`,
    b.prompt,
    `THE CLOTHES: the people wear exactly the real products in the reference photos — same garment type, cut, colour, wash, fabric, prints, stitching, hardware and any CARBON lettering. Shoes are exactly the referenced shoes; where a side is not visible in the photos, keep it plain. NEVER add another brand's logo, swoosh, stripes, monogram or wordmark to anything.`,
    `THE PEOPLE: new adult models (not the people in any reference photo), natural skin, real hands and faces, editorial hair and make-up.`,
    b.text
      ? `WORDS ON THE PICTURE: exactly "${b.text}" — nothing else written anywhere. Bold, clean, perfectly spelled, placed in the empty space the brief describes.`
      : "NO words, letters, numbers, signs or logos anywhere in the picture.",
    `Reference images, in order:\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n") || "(none)"}`,
  ].join("\n\n");
  return { prompt, images };
}

async function toPng(b: Buffer) {
  return sharp(b).rotate().png({ compressionLevel: 9 }).toBuffer();
}

async function drawBannerFast(prompt: string, size: string, images: Buffer[]): Promise<string> {
  const ai = openai();
  const common = { model: imageModel(), prompt, size: size as "1024x1024", quality: "high" as const, n: 1 };
  const r = images.length
    ? await ai.images.edit({ ...common, image: await Promise.all(images.map(async (b, i) => toFile(await toPng(b), `ref-${i}.png`, { type: "image/png" }))) })
    : await ai.images.generate({ ...common, moderation: "low" });
  const b64 = r.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no picture");
  return b64;
}

function versionDir(turn: { design_id: string; id: string }) {
  return `email/designs/${turn.design_id}/v-${turn.id.replace(/-/g, "")}`;
}

export function hostedUrl(path: string): string {
  return `${WMS_BASE}/api/public/email-media/${path.replace(/^email\//, "")}`;
}

async function saveBanner(turn: LayoutTurn, b: Banner, b64: string): Promise<{ path: string; url: string }> {
  const jpg = await sharp(Buffer.from(b64, "base64")).flatten({ background: "#ffffff" }).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
  const path = `${versionDir(turn)}/${b.id.toLowerCase()}.jpg`;
  await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
  return { path, url: hostedUrl(path) };
}

const QA = `You check a generated fashion banner for CARBON against the real product photos it had to show.
Answer JSON {"ok": true|false, "problems": ["…"]}. Problems are only real, visible faults:
- any logo, swoosh, stripes, monogram or wordmark of ANOTHER brand (Nike, Adidas, Jordan, Puma, New Balance, Gucci, LV …) on clothes, shoes or anywhere;
- a garment or shoe that clearly differs from its real product photo (wrong type, colour, wash, print, length, or missing piece);
- words on the picture that differ from the required words (spelling, extra words), or any words when none are allowed;
- broken anatomy (extra fingers, melted faces), obvious AI artefacts.
Do not complain about pose, location, lighting or styling choices.`;

async function checkBanner(b64: string, b: Banner, turn: LayoutTurn): Promise<string[]> {
  const byId = new Map((turn.products ?? []).map((p) => [p.id, p]));
  const refs: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  for (const pid of b.products) {
    const p = byId.get(pid);
    if (!p?.image) continue;
    const img = await referencePhoto(p.image, 512);
    if (!img) continue;
    refs.push({ type: "text", text: `Real product: ${p.title}` });
    refs.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${img.toString("base64")}`, detail: "low" } });
  }
  const banner = await sharp(Buffer.from(b64, "base64")).resize({ width: 1280, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  const c = await openai().chat.completions.create({
    model: textModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: QA },
      {
        role: "user",
        content: [
          { type: "text", text: b.text ? `Required words on the picture: "${b.text}".` : "No words are allowed on the picture." },
          ...refs,
          { type: "text", text: "The banner to check:" },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${banner.toString("base64")}`, detail: "high" } },
        ],
      },
    ],
  });
  const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as { ok?: boolean; problems?: unknown };
  const problems = Array.isArray(j.problems) ? j.problems.map((x) => String(x).slice(0, 300)).slice(0, 6) : [];
  if (problems.length) return problems;
  return j.ok === false ? ["the check found a problem"] : [];
}

/** Check a drawn banner; redraw it once (fast) with the problems when needed; save it. */
async function finishBanner(turn: LayoutTurn, b: Banner, b64: string, inputs: { prompt: string; images: Buffer[] }, log: (m: string) => void): Promise<Banner> {
  let pic = b64;
  let problems = await checkBanner(pic, b, turn).catch(() => [] as string[]);
  if (problems.length) {
    log(`[email-layout] ${turn.id} ${b.id}: redrawing (${problems.join("; ")})`);
    try {
      pic = await drawBannerFast(`${inputs.prompt}\n\nA FIRST ATTEMPT HAD THESE FAULTS — fix every one:\n- ${problems.join("\n- ")}`, b.size, inputs.images);
      problems = await checkBanner(pic, b, turn).catch(() => [] as string[]);
    } catch (e) {
      log(`[email-layout] ${turn.id} ${b.id}: redraw failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const saved = await saveBanner(turn, b, pic);
  return { ...b, ...saved, qa: problems.length ? problems.join("; ") : null, error: null };
}

/** Fast: draw every new banner now (two at a time). */
export async function drawBannersFast(pool: Pool, turn: LayoutTurn, log: (m: string) => void): Promise<Banner[]> {
  const style = await styleGuide(pool, turn.tenant_id);
  const styleImgs = await styleRefs(style, 2);
  const out = [...(turn.banners ?? [])];
  const todo = out.map((b, i) => [b, i] as const).filter(([b]) => !b.url);
  for (let k = 0; k < todo.length; k += 2) {
    await Promise.all(
      todo.slice(k, k + 2).map(async ([b, i]) => {
        try {
          const inputs = await bannerInputs(b, turn, styleImgs);
          const b64 = await drawBannerFast(inputs.prompt, b.size, inputs.images);
          out[i] = await finishBanner(turn, b, b64, inputs, log);
        } catch (e) {
          out[i] = { ...b, error: e instanceof Error ? e.message.slice(0, 300) : String(e) };
        }
      }),
    );
  }
  return out;
}

/** Batch: one OpenAI batch with every new banner. */
export async function submitBanners(pool: Pool, turn: LayoutTurn): Promise<LayoutStage | null> {
  const todo = (turn.banners ?? []).filter((b) => !b.url);
  if (!todo.length) return null;
  const style = await styleGuide(pool, turn.tenant_id);
  const styleImgs = await styleRefs(style, 2);
  const ai = openai();
  const refFileIds: string[] = [];
  const lines: string[] = [];
  for (const b of todo) {
    const inputs = await bannerInputs(b, turn, styleImgs);
    const ids: string[] = [];
    for (const [i, img] of inputs.images.entries()) {
      const jpg = await sharp(img).jpeg({ quality: 92 }).toBuffer();
      const f = await ai.files.create({ file: await toFile(jpg, `email-${turn.id}-${b.id}-${i}.jpg`, { type: "image/jpeg" }), purpose: "vision" });
      ids.push(f.id);
    }
    refFileIds.push(...ids);
    lines.push(
      JSON.stringify({
        custom_id: `${turn.id}:${b.id}`,
        method: "POST",
        url: "/v1/images/edits",
        body: { model: imageModel(), prompt: inputs.prompt, size: b.size, quality: "high", moderation: "low", n: 1, images: ids.map((file_id) => ({ file_id })) },
      }),
    );
  }
  const input = await ai.files.create({ file: await toFile(Buffer.from(lines.join("\n") + "\n"), `email-${turn.id}-banners.jsonl`, { type: "application/jsonl" }), purpose: "batch" });
  const batch = await ai.batches.create({ input_file_id: input.id, endpoint: "/v1/images/edits", completion_window: "24h", metadata: { email_design_turn: turn.id, kind: "banners" } });
  return { kind: "banners", batchId: batch.id, inputFileId: input.id, refFileIds };
}

/** Batch came back: check + save each banner. Returns null while still running. */
export async function collectBanners(pool: Pool, turn: LayoutTurn, log: (m: string) => void): Promise<Banner[] | null> {
  const st = turn.batch_files!;
  const ai = openai();
  const b = await ai.batches.retrieve(st.batchId);
  if (["validating", "in_progress", "finalizing", "cancelling"].includes(b.status)) return null;
  const cleanup = async () => {
    for (const f of [st.inputFileId, ...st.refFileIds, b.output_file_id, b.error_file_id]) if (f) await ai.files.delete(f).catch(() => {});
  };
  const results = new Map<string, string>();
  const errors = new Map<string, string>();
  if (b.output_file_id) {
    const text = await (await ai.files.content(b.output_file_id)).text();
    for (const line of text.split("\n").filter(Boolean)) {
      const l = JSON.parse(line) as { custom_id: string; response?: { body?: { data?: { b64_json?: string }[]; error?: { message?: string } } }; error?: { message?: string } };
      const id = l.custom_id.split(":").pop()!;
      const b64 = l.response?.body?.data?.[0]?.b64_json;
      if (b64) results.set(id, b64);
      else errors.set(id, l.response?.body?.error?.message ?? l.error?.message ?? "no picture came back");
    }
  }
  await cleanup();
  const style = await styleGuide(pool, turn.tenant_id);
  const styleImgs = await styleRefs(style, 2);
  const out: Banner[] = [];
  for (const ban of turn.banners ?? []) {
    if (ban.url) {
      out.push(ban);
      continue;
    }
    const inputs = await bannerInputs(ban, turn, styleImgs);
    try {
      // Missing from the batch (rejected / failed): draw it now instead.
      const b64 = results.get(ban.id) ?? (await drawBannerFast(inputs.prompt, ban.size, inputs.images));
      out.push(await finishBanner(turn, ban, b64, inputs, log));
    } catch (e) {
      out.push({ ...ban, error: errors.get(ban.id) ?? (e instanceof Error ? e.message.slice(0, 300) : String(e)) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ render */

const RATIO_H = (ratio: string, w: number) => {
  const [a, b] = ratio.split("x").map(Number);
  return Math.round((w * b) / a);
};

/** Fill the slots with hosted pictures; real photos are only cropped / resized. */
export async function renderLayout(pool: Pool, turn: LayoutTurn, html: string): Promise<{ html: string; missing: string[] }> {
  const products = new Map((turn.products ?? []).map((p) => [`p${gnum(p.id)}`, p]));
  const media = new Map<string, TurnMedia>();
  for (const m of turn.media ?? []) media.set(m.kind === "store" ? (STORE_MEDIA.find((s) => s.id === m.id)?.ref.toLowerCase() ?? m.id) : `m${gnum(m.id)}`, m);
  for (const s of STORE_MEDIA) media.set(s.ref.toLowerCase(), s);
  const banners = new Map((turn.banners ?? []).map((b) => [b.id.toLowerCase(), b]));
  const atts = await pool.query<{ attachments: Attachment[] | null }>(
    `SELECT attachments FROM email_design_messages WHERE design_id = $1::uuid AND role = 'owner' AND created_at <= $2 ORDER BY created_at`,
    [turn.design_id, turn.created_at],
  );
  const attachments = atts.rows.flatMap((r) => r.attachments ?? []);
  const missing: string[] = [];
  const cache = new Map<string, string>();

  const crop = async (key: string, ratio: string, load: () => Promise<Buffer | null>): Promise<string | null> => {
    const ck = `${key}:${ratio}`;
    if (cache.has(ck)) return cache.get(ck)!;
    const src = await load();
    if (!src) return null;
    const w = 1200;
    const jpg = await sharp(src).rotate().flatten({ background: "#ffffff" }).resize({ width: w, height: RATIO_H(ratio, w), fit: "cover", position: sharp.strategy.attention }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    const path = `${versionDir(turn)}/${key}-${ratio}.jpg`;
    await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
    const url = hostedUrl(path);
    cache.set(ck, url);
    return url;
  };
  const plain = async (key: string, load: () => Promise<Buffer | null>): Promise<string | null> => {
    if (cache.has(key)) return cache.get(key)!;
    const src = await load();
    if (!src) return null;
    const jpg = await sharp(src).rotate().flatten({ background: "#ffffff" }).resize({ width: 1200, withoutEnlargement: true }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    const path = `${versionDir(turn)}/${key}.jpg`;
    await uploadBytesToStorage({ path, bytes: jpg, contentType: "image/jpeg" });
    const url = hostedUrl(path);
    cache.set(key, url);
    return url;
  };
  const fromUrl = (u: string) => () => referencePhoto(u, 1600);
  const cdn = (u: string) => `${u}${u.includes("?") ? "&" : "?"}width=1200`;

  const resolveImg = async (key: string, ratio?: string): Promise<string | null> => {
    if (key === "none") return null;
    const ban = banners.get(key);
    if (ban) return ban.url ?? null;
    const p = products.get(key);
    if (p?.image) return ratio ? crop(key, ratio, fromUrl(p.image)) : cdn(p.image);
    const m = media.get(key);
    if (m) return ratio ? crop(key, ratio, fromUrl(m.url)) : cdn(m.url);
    const a = /^a(\d+)$/.exec(key);
    if (a) {
      const att = attachments[Number(a[1]) - 1];
      if (!att) return null;
      const load = async () => Buffer.from((await downloadStorageObject(att.path)).body);
      return ratio ? crop(key, ratio, load) : plain(key, load);
    }
    return null;
  };

  // Resolve every slot (sequentially: few pictures, and each may upload).
  const found = [...html.matchAll(SLOT)];
  const values = new Map<string, string | null>();
  for (const m of found) {
    const [all, kind, key, ratio] = m;
    if (values.has(all)) continue;
    if (kind === "link") {
      values.set(all, products.get(key)?.url ?? "{{shop_url}}");
      continue;
    }
    const url = await resolveImg(key, ratio).catch(() => null);
    if (!url) missing.push(key);
    values.set(all, url);
  }
  let out = html;
  // An <img> whose picture is missing is removed (never a broken picture in a sent email).
  out = out.replace(/<img\b[^>]*>/gi, (tag) => {
    const s = /src\s*=\s*(["'])(\{\{[^}]+\}\})\1/i.exec(tag);
    if (!s || !values.has(s[2])) return tag; // logo slots are filled below
    const v = values.get(s[2]);
    return v ? tag.replace(s[2], v) : "";
  });
  for (const [k, v] of values) if (v) out = out.split(k).join(v);
  out = out.replace(/\{\{\s*logo\s*:\s*white\s*\}\}/gi, LOGO_URLS.longWhite).replace(/\{\{\s*logo\s*:\s*(black)?\s*\}\}/gi, LOGO_URLS.longBlack);
  out = out.replace(SLOT, "");
  return { html: sanitizeEmailHtml(out), missing: [...new Set(missing)] };
}
