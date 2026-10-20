import { withActivity } from "@/lib/server/activity-log";
/**
 * Bulk Studio: get an uploaded item photo ready on its own (owner, 2026-10-20).
 *
 *  1. Upright — the proven pick-the-upright-one-of-four check (studio-upright).
 *  2. Which view — front / back / general (a detail, a label, a side view…).
 *  3. Head — when a person's head shows at the top, cut the photo just under
 *     the chin. Only the head: the neck, collar and garment stay. The model
 *     picks one of numbered lines drawn across the photo (naming a pixel
 *     position is unreliable; choosing a drawn line is not).
 *
 * The prepared copy is a NEW object (the original stays, like a crop or a
 * rotate), so the manual rotate / crop / drag tools still work on it.
 *
 * POST { url, item? } → { url, view, turned, headCut }   (view "styling" = another product worn with it)
 */
import OpenAI from "openai";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { downloadStorageObject, tryGetStoragePathFromUrl, uploadBytesToStorage } from "@/lib/storageProvider";
import { confirmTurn, detectUprightTurns } from "@/lib/server/studio-upright";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** The head is looked for in the top half only, zoomed, with 30 numbered lines
    across it (each line ≈ 1.7 % of the full height). */
const REGION = 0.5;
const LINES = Array.from({ length: 30 }, (_, i) => ((i + 1) / 31) * REGION);

async function linedCopy(img: Buffer): Promise<string> {
  const meta = await sharp(img).metadata();
  const W0 = meta.width ?? 0;
  const H0 = meta.height ?? 0;
  const top = await sharp(img).extract({ left: 0, top: 0, width: W0, height: Math.max(1, Math.round(H0 * REGION)) }).toBuffer();
  const small = await sharp(top).resize(1000, 1000, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer();
  const { width = 1000, height = 1000 } = await sharp(small).metadata();
  const marks = LINES.map((f, i) => {
    const y = Math.round((f / REGION) * height);
    return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#ff2d2d" stroke-width="1.5" opacity="0.8"/>
      <text x="6" y="${y - 2}" font-family="Arial" font-size="15" font-weight="700" fill="#ff2d2d" stroke="#fff" stroke-width="3" paint-order="stroke">${i + 1}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks}</svg>`);
  const out = await sharp(small).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 88 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

async function wholeCopy(img: Buffer): Promise<string> {
  const b = await sharp(img).resize(768, 768, { fit: "inside" }).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${b.toString("base64")}`;
}

/** After a cut: is any of the head still showing along the top edge? */
async function headLeft(client: OpenAI, model: string, img: Buffer): Promise<boolean> {
  const meta = await sharp(img).metadata();
  const strip = await sharp(img)
    .extract({ left: 0, top: 0, width: meta.width ?? 0, height: Math.max(1, Math.round((meta.height ?? 0) * 0.25)) })
    .resize(900, 900, { fit: "inside" })
    .jpeg({ quality: 85 })
    .toBuffer();
  const c = await client.chat.completions.create({
    model,
    temperature: 0,
    max_tokens: 20,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: 'This is the top of a cropped clothing photo. Is ANY part of a person\'s face, mouth, chin, beard, ear or head hair visible in it (a neck or a collar alone does not count)? JSON only: {"head": true|false}' },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${strip.toString("base64")}`, detail: "high" } },
        ],
      },
    ],
  });
  const j = JSON.parse(s(c.choices?.[0]?.message?.content) || "{}") as { head?: unknown };
  return j.head === true;
}

const promptFor = (item: string) => PROMPT.replace(
  "1. \"view\" (judge from IMAGE 1): which side of the GARMENT does the photo show?",
  `1. "view" (judge from IMAGE 1)${item ? ` — the product being shot is: ${item}` : ""}. Which does the photo show?`,
);

const PROMPT = `IMAGE 1 is one photo for a clothing catalog. IMAGE 2 is the TOP HALF of the same photo, zoomed, with numbered red lines drawn across it (line 1 near the top … line 30 at the bottom of that half).

1. "view" (judge from IMAGE 1): which side of the GARMENT does the photo show?
   - "front": the FRONT side of the product — the whole garment, OR a close-up of any part of its front (front pockets, fly, buttons, a cargo pocket or drawstring on the front of the leg, a front print). Detail shots of the front belong here so the generator sees them.
   - "back": the BACK side of the product — the whole garment, OR a close-up of any part of its back (back pockets, back yoke, back waistband, a back print).
   - "general": only when the side cannot be told or does not apply — the inside or a care label, a fabric swatch, a true side view, an accessory or several items together
   - "styling": a DIFFERENT product that is only worn WITH the product being shot — e.g. shoes, a shirt or top when the product is a bottom, pants when the product is a top, a bracelet, a bag — photographed on its own
2. "headLine" (use IMAGE 2): if a PERSON'S HEAD (face, chin, beard or hair) shows at the top of the photo: the number of the FIRST red line that has NO part of the head below it — every bit of the face, the chin, the beard and the hair (on a back view: the hair and the back of the head, down to the hairline on the neck) lies ABOVE that line, and only neck, collar and garment lie below it. Cutting there removes the whole head and nothing else. The line must never cut into the garment or its collar. No head, a mannequin without a head, or a garment with no person: null.

JSON only: {"view": "front"|"back"|"general"|"styling", "headLine": number|null}`;

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { url?: unknown; item?: unknown };
  const url = s(body.url);
  const item = s(body.item).slice(0, 160);
  const path = tryGetStoragePathFromUrl(url);
  if (!path || !(path.startsWith(`carbon-studio/item-refs/${session.tid}/`) || path.startsWith("carbon-studio/handoff/"))) {
    return NextResponse.json({ error: "Not a Studio photo." }, { status: 400 });
  }
  const apiKey = s(getOpenAiApiKey());
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  const client = new OpenAI({ apiKey });
  const model = (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o";

  try {
    const { body: raw } = await downloadStorageObject(path);
    let img = await sharp(Buffer.from(raw)).autoOrient().toBuffer();

    // 1. Upright.
    const turns = await detectUprightTurns(client, model, [{ data: img.toString("base64") }]).catch(() => new Map<number, number>());
    const proposed = (turns.get(1) ?? 0) as 0 | 90 | 180 | 270;
    /* A turn needs a second opinion: the first check alone turned upright photos. */
    const turn = proposed && (await confirmTurn(client, model, img, proposed).catch(() => false)) ? proposed : 0;
    if (turn) img = await sharp(img).rotate(turn).toBuffer();

    // 2 + 3. View and head line, on the upright photo.
    const c = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 80,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You sort clothing catalog photos. Output valid JSON only." },
        {
          role: "user",
          content: [
            { type: "text", text: promptFor(item) },
            { type: "text", text: "IMAGE 1:" },
            { type: "image_url", image_url: { url: await wholeCopy(img), detail: "low" } },
            { type: "text", text: "IMAGE 2:" },
            { type: "image_url", image_url: { url: await linedCopy(img), detail: "high" } },
          ],
        },
      ],
    });
    const j = JSON.parse(s(c.choices?.[0]?.message?.content) || "{}") as { view?: unknown; headLine?: unknown };
    const view = j.view === "front" || j.view === "back" || (j.view === "styling" && item) ? j.view : "general";
    const line = Number(j.headLine);
    let headCut = false;
    if (Number.isInteger(line) && line >= 1 && line <= LINES.length) {
      const meta = await sharp(img).metadata();
      const h = meta.height ?? 0;
      const w = meta.width ?? 0;
      /* One line of margin under the pick, then look again and trim a little
         more while any of the head is still there. Tuned on real model photos
         (2026-10-20): every head fully removed; a high collar (turtleneck) can
         lose its top edge — the manual crop is there for that. */
      let cut = Math.min(LINES[line - 1] + (1 / 31) * REGION, REGION);
      const cropAt = (f: number) => sharp(img).extract({ left: 0, top: Math.round(f * h), width: w, height: h - Math.round(f * h) }).toBuffer();
      let out = await cropAt(cut);
      for (let k = 0; k < 2 && (await headLeft(client, model, out).catch(() => false)); k++) {
        cut = Math.min(cut + 0.025, REGION + 0.1);
        out = await cropAt(cut);
      }
      if (h && h * (1 - cut) > h * 0.35) {
        img = out;
        headCut = true;
      }
    }

    if (!turn && !headCut) return NextResponse.json({ url, view, turned: 0, headCut: false });
    const bytes = await sharp(img).jpeg({ quality: 92 }).toBuffer();
    const dest = `carbon-studio/item-refs/${session.tid}/${crypto.randomUUID()}/${Date.now()}.jpg`;
    const uploaded = await uploadBytesToStorage({ path: dest, bytes: new Uint8Array(bytes), contentType: "image/jpeg" });
    return NextResponse.json({ url: uploaded.url, view, turned: turn, headCut });
  } catch (e) {
    console.error("[studio/auto-prep]", e);
    return NextResponse.json({ error: "Could not prepare this photo." }, { status: 500 });
  }
}

export const POST = withActivity("studio/auto-prep", POST_handler);
