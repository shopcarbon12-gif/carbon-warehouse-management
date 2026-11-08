/**
 * CarbonWMS Email — AI Designer (owner, 2026-11-07).
 *
 * A chat per design. Every owner message ("make the hero bigger", "use these
 * photos", spoken or typed) becomes one AI turn that answers in words and
 * draws the WHOLE email twice: a desktop view and a mobile view. The owner
 * chooses what a message changes — both views, only desktop, or only mobile;
 * a view that is not changed is carried over exactly.
 *
 * One turn:
 *  1. plan (live, a few seconds): the text model reads the conversation, the
 *     current two pictures and any photos the owner attached, and writes the
 *     reply plus one picture prompt per view to change;
 *  2. pictures (OpenAI images — the Batch API at half price, or Fast):
 *     desktop first; then the phone view is made FROM the new desktop picture
 *     (so both always match), with the previous phone view as layout guide.
 *     Only-mobile turns edit the previous phone view; only-desktop turns edit
 *     the previous desktop view.
 *
 * The worker's email tick (every minute) moves turns forward; nothing here
 * runs in the owner's browser, so leaving the page does not stop it.
 */
import sharp from "sharp";
import OpenAI, { toFile } from "openai";
import type { Pool } from "pg";
import { downloadStorageObject, uploadBytesToStorage } from "@/lib/storageProvider";
import { DESKTOP_SIZE, MOBILE_SIZE, imageModel, openai, textModel, transcribeModel } from "./config";
import { catalogLines, inStockCatalog, logoReference, productPhoto, type CatalogProduct } from "./catalog";
import { STORE_TEXT, mediaLibrary, mediaLines, mediaPhoto, type MediaItem, type TurnMedia } from "./brand";

export type TurnProduct = { id: string; title: string; url: string; price: number; image: string | null };

export type View = "desktop" | "mobile";
export type Target = "both" | View;

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
  batch_id: string | null;
  batch_files: Stage | null;
  error: string | null;
  products: TurnProduct[] | null;
  media: TurnMedia[] | null;
  created_at: Date;
};

/** Where a turn's pictures are: which view is being drawn and which OpenAI files to clean up. */
type Stage = { view: View; batchId?: string; inputFileId?: string; refFileIds?: string[] };

export const SAMPLE_NAME = "Maria";
export const SAMPLE_CODE = "CB20-K7Q4XM";

const BRAND = `CARBON is a fashion retailer in Orlando, Florida (store + shopcarbon.com): trendy streetwear and going-out looks for men and women.
Brand look: clean black and white, lots of white space, bold sans-serif headings, fashion photography that fills the width.
The logo is the official CARBON logo (a hexagon-cell mark followed by the word CARBON in a thin geometric sans-serif, wide letter-spacing). It is always given as a reference picture: reproduce exactly that logo, never redraw it in another font or style.
Never mention other brands, never invent prices, discounts or dates the owner did not give, never write "Carbon Jeans".
${STORE_TEXT}`;

const VIEW_RULES: Record<View, string> = {
  desktop: `Show the email flat and full-length exactly as it renders in a DESKTOP email client: one 600-pixel-wide email column that fills the ENTIRE image width, from the top of the email to the bottom. No browser, no inbox window, no device frame, no desk, no shadow, no background around the email.`,
  mobile: `Show the email flat and full-length exactly as it renders on a PHONE (a 375-pixel-wide screen): one column that fills the ENTIRE image width, from the top of the email to the bottom. Stack side-by-side blocks vertically, make headings fit the narrow width, make buttons full-width and easy to tap, keep body text large enough to read on a phone. No phone frame, no status bar, no app chrome, no background around the email.`,
};

const COMMON_RULES = `Put the official CARBON logo (from its reference picture, exactly as given) at the top of the email, centred, unless the description places it elsewhere. Typography must be crisp and perfectly spelled, exactly the words given. Personal parts use sample values: the customer's first name is "${SAMPLE_NAME}" and a personal discount code (when there is one) is "${SAMPLE_CODE}" shown in a clearly separate box. Buttons are solid rectangles with their label inside. Photos are real-looking fashion photography with no words written on them. Leave out any unsubscribe line, legal footer or postal address (added automatically later). Nothing may be cut off at the edges.`;

function sizeOf(v: View) {
  return v === "desktop" ? DESKTOP_SIZE : MOBILE_SIZE;
}

export function pictureFrame(view: View, plannerPrompt: string, fromDesktop: boolean): string {
  const lead =
    view === "mobile" && fromDesktop
      ? "The FIRST image is the finished DESKTOP version of this email. Make the PHONE version of the SAME email: the same words, photos, colours, order of sections and style, re-laid-out for a narrow screen." +
        " If a second image is given it is the previous phone version: keep its layout choices unless the instructions change them."
      : "Make a CARBON marketing email design.";
  return [lead, VIEW_RULES[view], COMMON_RULES, `Brand: ${BRAND}`, `What this version must show:\n${plannerPrompt}`].join("\n\n");
}

/* ------------------------------------------------------------------ queries */

export async function listMessages(pool: Pool, designId: string): Promise<Msg[]> {
  const r = await pool.query<Msg>(`SELECT * FROM email_design_messages WHERE design_id = $1::uuid ORDER BY created_at, role DESC`, [designId]);
  return r.rows;
}

/** The newest finished picture of each view up to (and including) a message. */
async function currentViews(pool: Pool, designId: string, before?: Date): Promise<{ desktop: string | null; mobile: string | null }> {
  const r = await pool.query<{ desktop_path: string | null; mobile_path: string | null }>(
    `SELECT desktop_path, mobile_path FROM email_design_messages
      WHERE design_id = $1::uuid AND role = 'ai' AND status = 'done' AND ($2::timestamptz IS NULL OR created_at < $2)
      ORDER BY created_at DESC LIMIT 1`,
    [designId, before ?? null],
  );
  return { desktop: r.rows[0]?.desktop_path ?? null, mobile: r.rows[0]?.mobile_path ?? null };
}

/** Owner message + the AI turn that answers it. */
export async function addOwnerMessage(
  pool: Pool,
  input: { designId: string; text: string; attachments: { path: string; name: string }[]; target: Target; mode: "batch" | "fast"; by: string | null },
): Promise<{ ownerId: string; aiId: string }> {
  const busy = await pool.query(`SELECT 1 FROM email_design_messages WHERE design_id = $1::uuid AND status IN ('queued','planning','generating') LIMIT 1`, [input.designId]);
  if (busy.rowCount) throw new Error("The AI is still working on the last message. Wait for it to finish (or stop it) before sending another.");
  const views = await currentViews(pool, input.designId);
  // The first turn always draws both views.
  const target: Target = !views.desktop || !views.mobile ? "both" : input.target;
  const o = await pool.query<{ id: string }>(
    `INSERT INTO email_design_messages (design_id, role, text, attachments, target, status, created_by) VALUES ($1::uuid, 'owner', $2, $3, $4, 'done', $5) RETURNING id`,
    [input.designId, input.text, JSON.stringify(input.attachments), target, input.by],
  );
  const a = await pool.query<{ id: string }>(
    `INSERT INTO email_design_messages (design_id, role, target, mode, status, created_at) VALUES ($1::uuid, 'ai', $2, $3, 'queued', now() + interval '1 millisecond') RETURNING id`,
    [input.designId, target, input.mode],
  );
  await pool.query(`UPDATE email_designs SET updated_at = now(), status = CASE WHEN status = 'failed' THEN 'drafting' ELSE status END WHERE id = $1::uuid`, [input.designId]);
  return { ownerId: o.rows[0].id, aiId: a.rows[0].id };
}

/** Stop a turn that is still waiting / being drawn. */
export async function stopTurn(pool: Pool, designId: string): Promise<boolean> {
  const r = await pool.query<{ batch_files: Stage | null }>(
    `UPDATE email_design_messages SET status = 'failed', error = 'Stopped', finished_at = now()
      WHERE design_id = $1::uuid AND status IN ('queued','planning','generating') RETURNING batch_files`,
    [designId],
  );
  for (const row of r.rows) {
    if (row.batch_files?.batchId) await openai().batches.cancel(row.batch_files.batchId).catch(() => {});
  }
  return (r.rowCount ?? 0) > 0;
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
  desktop_prompt: string | null;
  mobile_prompt: string | null;
  products: TurnProduct[];
  media: TurnMedia[];
};

/** The brand pictures of the latest finished version before this turn. */
async function previousMedia(pool: Pool, turn: Msg): Promise<TurnMedia[]> {
  const r = await pool.query<{ media: TurnMedia[] | null }>(
    `SELECT media FROM email_design_messages WHERE design_id = $1::uuid AND role = 'ai' AND status = 'done' AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
    [turn.design_id, turn.created_at],
  );
  return r.rows[0]?.media ?? [];
}

/** The products of the latest finished version before this turn. */
async function previousProducts(pool: Pool, turn: Msg): Promise<TurnProduct[]> {
  const r = await pool.query<{ products: TurnProduct[] | null }>(
    `SELECT products FROM email_design_messages WHERE design_id = $1::uuid AND role = 'ai' AND status = 'done' AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
    [turn.design_id, turn.created_at],
  );
  return r.rows[0]?.products ?? [];
}

const PLAN_SYSTEM = `You are the email designer inside CarbonWMS, working for the owner of CARBON.
${BRAND}

The owner describes an email (or changes to it) in a chat. Each of your turns produces two full-length pictures of the email: a DESKTOP view (600 px column) and a MOBILE view (375 px phone). The owner's message says which view(s) to change: "both", "desktop" or "mobile".

Write JSON with:
- reply: 1–3 short plain sentences to the owner about what you did or are drawing (no em dashes, no hype). If something they asked for is impossible or unclear, say so here and make your best version anyway.
- title: a 2–5 word name for this email (only on the first turn, otherwise null).
- subject: a subject line (max 60 characters, may use {{first_name}}), or null to keep the previous one.
- preheader: the inbox preview text (max 90 characters), or null to keep the previous one.
- desktop_prompt: when the desktop view changes, a complete, self-contained description of the WHOLE desktop email from top to bottom: every section in order, the exact words of every heading, paragraph and button, the photos (what they show, which attached photo to use: "attached photo 1"…), colours, alignment and spacing. Never write "same as before": describe everything, carrying over what does not change. Null when the desktop view does not change.
- mobile_prompt: the same for the phone view, when it changes (describe the narrow layout: stacked blocks, full-width buttons). Null when the mobile view does not change.
- products: the catalog refs you use in this version, e.g. ["P12","P40"] (at most 6), or null to keep the previous version's products.

CATALOG (the real CARBON products in stock right now, from the store's catalog) is listed in the message as: ref | name | type | men/women | colours | price | stock.
- Whenever the email shows clothing, use ONLY real catalog products: never invent garments. Style real looks from them (e.g. a jacket + jeans + sneakers that go together) and pick by season, the owner's request, and stock (prefer stock 3 or more).
- In desktop_prompt / mobile_prompt refer to each product as "catalog photo of <ref> (<name>)" and say where it goes; the picture model receives each chosen product's real photo.
- Product names and prices shown in the email must be exactly the catalog's. Never show a price the catalog doesn't give.
- The official logo is always supplied; describe where it sits, never how to draw it.
- media: the BRAND MEDIA refs you use in this version, e.g. ["S1","M7"] (at most 4), or null to keep the previous version's pictures.

BRAND MEDIA (CARBON's own pictures from its Shopify store: store photos S1/S2, campaign banners and lifestyle shots M1…) is listed as: ref | kind | shape | description.
- For any big photo (hero banner, store section, lifestyle strip) prefer a fitting BRAND MEDIA picture over inventing one. In the prompts refer to it as "brand photo <ref> (<short description>)" and say where it goes and how it is cropped; the picture model receives the real picture.
- When the email mentions the store, a visit, opening hours or directions, use the exact store facts above and show the store photo (S1 outside or S2 inside); a "Get directions" button goes to Google Maps.
- Pick wide banners for wide spots and tall pictures for tall spots; never stretch them.

Personal parts: the customer's first name appears as "${SAMPLE_NAME}", a personal code as "${SAMPLE_CODE}". Do not add an unsubscribe line or postal address (added automatically).`;

async function plan(pool: Pool, turn: Msg): Promise<Plan> {
  const history = await pool.query<{ role: string; text: string; target: string; attachments: { path: string; name: string }[] }>(
    `SELECT role, text, target, attachments FROM email_design_messages WHERE design_id = $1::uuid AND created_at < $2 AND (role = 'owner' OR status = 'done') ORDER BY created_at`,
    [turn.design_id, turn.created_at],
  );
  const views = await currentViews(pool, turn.design_id, turn.created_at);
  const owner = history.rows.filter((h) => h.role === "owner").at(-1);
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
  content.push({
    type: "text",
    text:
      `Conversation so far:\n${history.rows.map((h) => `${h.role === "owner" ? `OWNER (change: ${h.target})` : "YOU"}: ${h.text}`).join("\n")}\n\n` +
      `This turn changes: ${turn.target}.` +
      (views.desktop || views.mobile ? " The current pictures follow (desktop first, then mobile)." : " There is no design yet: this is the first version, describe both views."),
  });
  if (views.desktop) content.push({ type: "image_url", image_url: { url: await asDataUrl(views.desktop), detail: "high" } });
  if (views.mobile) content.push({ type: "image_url", image_url: { url: await asDataUrl(views.mobile), detail: "high" } });
  let catalog: CatalogProduct[] = [];
  try {
    catalog = await inStockCatalog();
  } catch (e) {
    console.warn("[email-ai] catalog unavailable:", e instanceof Error ? e.message : e);
  }
  const prevProducts = await previousProducts(pool, turn);
  const refOf = (id: string) => catalog.find((c) => c.id === id)?.ref;
  content.push({
    type: "text",
    text: catalog.length
      ? `CATALOG (${catalog.length} products in stock):\n${catalogLines(catalog)}\n\n` +
        (prevProducts.length ? `Products in the current version: ${prevProducts.map((p) => `${refOf(p.id) ?? "(no longer in stock)"} ${p.title}`).join(", ")}.` : "No products chosen yet.")
      : "The catalog could not be read right now: do not show specific products; use attached photos only.",
  });
  const library: MediaItem[] = await mediaLibrary(pool);
  const prevMedia = await previousMedia(pool, turn);
  const mediaRef = (id: string) => library.find((m) => m.id === id)?.ref;
  content.push({
    type: "text",
    text:
      `BRAND MEDIA (${library.length} pictures):\n${mediaLines(library)}\n\n` +
      (prevMedia.length ? `Brand pictures in the current version: ${prevMedia.map((m) => mediaRef(m.id) ?? "(removed)").join(", ")}.` : "No brand pictures chosen yet."),
  });
  const atts = owner?.attachments ?? [];
  for (const [i, a] of atts.entries()) {
    content.push({ type: "text", text: `Attached photo ${i + 1} (${a.name}):` });
    content.push({ type: "image_url", image_url: { url: await asDataUrl(a.path, 768), detail: "low" } });
  }
  const c = await openai().chat.completions.create({
    model: textModel(),
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content },
    ],
  });
  const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as Omit<Partial<Plan>, "products" | "media"> & { products?: unknown; media?: unknown };
  const want = (v: View) => turn.target === "both" || turn.target === v;
  const out: Plan = {
    reply: String(j.reply ?? "Here is the new version.").slice(0, 1200),
    title: j.title ? String(j.title).slice(0, 80) : null,
    subject: j.subject ? String(j.subject).slice(0, 120) : null,
    preheader: j.preheader ? String(j.preheader).slice(0, 200) : null,
    desktop_prompt: want("desktop") ? String(j.desktop_prompt ?? owner?.text ?? "").slice(0, 8000) : null,
    mobile_prompt: want("mobile") ? String(j.mobile_prompt ?? j.desktop_prompt ?? owner?.text ?? "").slice(0, 8000) : null,
    products: Array.isArray(j.products)
      ? (j.products as unknown[])
          .map((r) => catalog.find((c) => c.ref === String(r).trim().toUpperCase()))
          .filter((p): p is CatalogProduct => !!p)
          .slice(0, 6)
          .map((p) => ({ id: p.id, title: p.title, url: p.url, price: p.price, image: p.image }))
      : prevProducts,
    media: Array.isArray(j.media)
      ? (j.media as unknown[])
          .map((r) => library.find((m) => m.ref === String(r).trim().toUpperCase()))
          .filter((m): m is MediaItem => !!m)
          .slice(0, 4)
          .map((m) => ({ id: m.id, url: m.url, width: m.width, height: m.height, kind: m.kind, description: m.description }))
      : prevMedia,
  };
  return out;
}

/* ------------------------------------------------------------------ pictures */

type Inputs = { prompt: string; size: string; images: Buffer[] };

/** The picture model takes at most 16 input images. */
const MAX_REFS = 16;

/** What one view's picture is drawn from. */
async function inputsFor(pool: Pool, turn: Msg, view: View, newDesktop: string | null): Promise<Inputs> {
  const prev = await currentViews(pool, turn.design_id, turn.created_at);
  const owner = await pool.query<{ attachments: { path: string; name: string }[] }>(
    `SELECT attachments FROM email_design_messages WHERE design_id = $1::uuid AND role = 'owner' AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
    [turn.design_id, turn.created_at],
  );
  const atts = (owner.rows[0]?.attachments ?? []).slice(0, 6);
  const load = async (p: string) => Buffer.from((await downloadStorageObject(p)).body);
  const images: Buffer[] = [];
  let fromDesktop = false;
  if (view === "desktop") {
    if (prev.desktop) images.push(await load(prev.desktop));
  } else if (newDesktop || (turn.target === "both" && prev.desktop)) {
    // Phone view made from the (new) desktop picture, previous phone view as layout guide.
    images.push(await load(newDesktop ?? prev.desktop!));
    if (prev.mobile) images.push(await load(prev.mobile));
    fromDesktop = true;
  } else if (prev.mobile) {
    images.push(await load(prev.mobile));
  }
  // Every reference after the base pictures is labelled, so the model knows which is which.
  const labels: string[] = images.map((_, i) =>
    view === "desktop" ? "the current desktop version (edit it)" : i === 0 && fromDesktop ? "the finished desktop version" : i === 0 ? "the current phone version (edit it)" : "the previous phone version (layout guide)",
  );
  images.push(await logoReference());
  labels.push("the official CARBON logo (reference only: copy it exactly, do not edit this image)");
  for (const [i, a] of atts.entries()) {
    images.push(await load(a.path));
    labels.push(`attached photo ${i + 1} (${a.name})`);
  }
  for (const p of (turn.products ?? []).slice(0, 6)) {
    if (images.length >= MAX_REFS) break;
    const cat: CatalogProduct = { ref: "", id: p.id, title: p.title, url: p.url, type: "", gender: "unisex", colors: [], sizes: [], price: p.price, compareAt: null, stock: 0, image: p.image };
    const b = await productPhoto(cat);
    if (!b) continue;
    images.push(b);
    labels.push(`catalog photo of ${p.title}: the real garment(s), keep them exactly (cut, colour, details)`);
  }
  for (const m of (turn.media ?? []).slice(0, 4)) {
    if (images.length >= MAX_REFS) break;
    const b = await mediaPhoto(m);
    if (!b) continue;
    images.push(b);
    labels.push(`brand photo (${m.description.slice(0, 120)}): CARBON's own picture, use it as the photo in the spot the description gives (crop to fit, keep people, clothes and place the same, do not redraw)`);
  }
  const plannerPrompt = (view === "desktop" ? turn.desktop_prompt : turn.mobile_prompt) ?? "";
  const legend = `\n\nThe input images, in order:\n${labels.map((l, i) => `${i + 1}. ${l}`).join("\n")}` +
    (labels[0]?.startsWith("the official") ? "\nThere is no earlier version: create the whole email new; image 1 is only the logo." : "");
  return { prompt: pictureFrame(view, plannerPrompt, fromDesktop) + legend, size: sizeOf(view), images };
}

async function toPng(b: Buffer): Promise<Buffer> {
  return sharp(b).rotate().png({ compressionLevel: 9 }).toBuffer();
}

async function savePicture(turn: Msg, view: View, b64: string): Promise<string> {
  const png = await sharp(Buffer.from(b64, "base64")).png({ compressionLevel: 9 }).toBuffer();
  const path = `email/designs/${turn.design_id}/${turn.id}-${view}.png`;
  await uploadBytesToStorage({ path, bytes: png, contentType: "image/png" });
  return path;
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

async function submitBatch(turn: Msg, view: View, inputs: Inputs): Promise<Stage> {
  const ai = openai();
  const refFileIds: string[] = [];
  for (const [i, b] of inputs.images.entries()) {
    const jpg = await sharp(b).rotate().jpeg({ quality: 92 }).toBuffer();
    const f = await ai.files.create({ file: await toFile(jpg, `email-${turn.id}-${view}-${i}.jpg`, { type: "image/jpeg" }), purpose: "vision" });
    refFileIds.push(f.id);
  }
  const edit = refFileIds.length > 0;
  const line = {
    custom_id: `${turn.id}:${view}`,
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
  const input = await ai.files.create({ file: await toFile(Buffer.from(JSON.stringify(line) + "\n"), `email-${turn.id}-${view}.jsonl`, { type: "application/jsonl" }), purpose: "batch" });
  const batch = await ai.batches.create({
    input_file_id: input.id,
    endpoint: edit ? "/v1/images/edits" : "/v1/images/generations",
    completion_window: "24h",
    metadata: { email_design_turn: turn.id, view },
  });
  return { view, batchId: batch.id, inputFileId: input.id, refFileIds };
}

async function cleanup(ai: OpenAI, st: Stage | null, ...more: (string | null | undefined)[]) {
  for (const f of [st?.inputFileId, ...(st?.refFileIds ?? []), ...more]) if (f) await ai.files.delete(f).catch(() => {});
}

async function fail(pool: Pool, id: string, why: string) {
  await pool.query(`UPDATE email_design_messages SET status = 'failed', error = $2, finished_at = now() WHERE id = $1::uuid`, [id, why.slice(0, 800)]);
}

/** The views this turn still has to draw, in order (desktop before a phone view made from it). */
function viewsToDraw(t: Target): View[] {
  return t === "both" ? ["desktop", "mobile"] : [t];
}

/** Finish: carry over the view that did not change. */
async function complete(pool: Pool, turn: Msg) {
  const prev = await currentViews(pool, turn.design_id, turn.created_at);
  await pool.query(
    `UPDATE email_design_messages SET status = 'done', finished_at = now(), batch_id = NULL, batch_files = NULL,
            desktop_path = COALESCE(desktop_path, $2), mobile_path = COALESCE(mobile_path, $3) WHERE id = $1::uuid`,
    [turn.id, prev.desktop, prev.mobile],
  );
  await pool.query(`UPDATE email_designs SET updated_at = now() WHERE id = $1::uuid`, [turn.design_id]);
}

/** Start the next view of a turn (fast: draw it now; batch: submit it). */
async function drawNext(pool: Pool, turn: Msg, log: (m: string) => void): Promise<void> {
  const order = viewsToDraw(turn.target);
  for (const view of order) {
    const done = view === "desktop" ? turn.desktop_path : turn.mobile_path;
    if (done) continue;
    const inputs = await inputsFor(pool, turn, view, view === "mobile" ? turn.desktop_path : null);
    if (turn.mode === "fast") {
      await pool.query(`UPDATE email_design_messages SET status = 'generating' WHERE id = $1::uuid`, [turn.id]);
      const b64 = await drawFast(inputs);
      const path = await savePicture(turn, view, b64);
      await pool.query(`UPDATE email_design_messages SET ${view}_path = $2 WHERE id = $1::uuid`, [turn.id, path]);
      if (view === "desktop") turn.desktop_path = path;
      else turn.mobile_path = path;
      log(`[email-ai] turn ${turn.id}: ${view} drawn (fast)`);
      continue;
    }
    const st = await submitBatch(turn, view, inputs);
    await pool.query(`UPDATE email_design_messages SET status = 'generating', batch_id = $2, batch_files = $3 WHERE id = $1::uuid`, [turn.id, st.batchId, JSON.stringify(st)]);
    log(`[email-ai] turn ${turn.id}: ${view} sent to the OpenAI batch ${st.batchId}`);
    return;
  }
  await complete(pool, turn);
}

/** Called by the tick. */
export async function runDesignTurns(pool: Pool, log: (m: string) => void = console.log): Promise<{ planned: number; collected: number }> {
  let planned = 0;
  let collected = 0;
  // 0. A turn cut off by a restart while planning / drawing fast.
  await pool.query(
    `UPDATE email_design_messages SET status = 'failed', error = 'Interrupted (the server restarted). Send the message again.', finished_at = now()
      WHERE status IN ('planning','generating') AND batch_id IS NULL AND batch_files IS NULL AND created_at < now() - interval '20 minutes'`,
  );
  // 1. New turns: plan, then draw (fast) or submit (batch).
  const queued = await pool.query<Msg>(
    `UPDATE email_design_messages SET status = 'planning'
      WHERE id IN (SELECT id FROM email_design_messages WHERE status = 'queued' ORDER BY created_at LIMIT 3 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
  );
  for (const turn of queued.rows) {
    try {
      const p = await plan(pool, turn);
      await pool.query(
        `UPDATE email_design_messages SET text = $2, desktop_prompt = $3, mobile_prompt = $4, products = $5, media = $6 WHERE id = $1::uuid`,
        [turn.id, p.reply, p.desktop_prompt, p.mobile_prompt, JSON.stringify(p.products), JSON.stringify(p.media)],
      );
      await pool.query(
        `UPDATE email_designs SET title = CASE WHEN title = 'New email' AND $2::text IS NOT NULL THEN $2 ELSE title END,
                subject_hint = COALESCE($3, subject_hint), preheader_hint = COALESCE($4, preheader_hint), updated_at = now() WHERE id = $1::uuid`,
        [turn.design_id, p.title, p.subject, p.preheader],
      );
      turn.text = p.reply;
      turn.desktop_prompt = p.desktop_prompt;
      turn.mobile_prompt = p.mobile_prompt;
      turn.products = p.products;
      turn.media = p.media;
      planned++;
      await drawNext(pool, turn, log);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[email-ai] turn ${turn.id} failed: ${msg}`);
      await fail(pool, turn.id, `The AI could not make this version: ${msg}`);
    }
  }
  // 2. Batch pictures: collect what came back, then draw the next view.
  const out = await pool.query<Msg>(`SELECT * FROM email_design_messages WHERE status = 'generating' AND batch_files IS NOT NULL`);
  if (!out.rows.length) return { planned, collected };
  const ai = openai();
  for (const turn of out.rows) {
    const st = turn.batch_files!;
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
        await fail(pool, turn.id, `No ${st.view} picture came back: ${line.response?.body?.error?.message ?? line.error?.message ?? "unknown reason"}`);
        continue;
      }
      const path = await savePicture(turn, st.view, b64);
      await pool.query(`UPDATE email_design_messages SET ${st.view}_path = $2, status = 'planning', batch_id = NULL, batch_files = NULL WHERE id = $1::uuid`, [turn.id, path]);
      if (st.view === "desktop") turn.desktop_path = path;
      else turn.mobile_path = path;
      collected++;
      try {
        await drawNext(pool, turn, log);
      } catch (e) {
        await fail(pool, turn.id, `The AI could not make the ${st.view === "desktop" ? "phone" : "next"} view: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`[email-ai] turn ${turn.id} check failed: ${msg}`);
    }
  }
  return { planned, collected };
}

/* -------------------------------------------------------------- voice input */

export async function transcribe(audio: Buffer, mime: string, name: string): Promise<string> {
  const r = await openai().audio.transcriptions.create({
    model: transcribeModel(),
    file: await toFile(audio, name, { type: mime }),
    prompt: "An owner of the fashion store CARBON describes a marketing email: headings, photos, buttons, colours, discount codes.",
  });
  return (r.text ?? "").trim();
}
