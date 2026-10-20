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
 * POST { url } → { url, view, turned, headCut }
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
import { detectUprightTurns } from "@/lib/server/studio-upright";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
/** Cut lines offered for the head: 2 %, 4 % … 60 % of the height. */
const LINES = Array.from({ length: 30 }, (_, i) => (i + 1) * 0.02);

async function linedCopy(img: Buffer): Promise<string> {
  const small = await sharp(img).resize(900, 900, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer();
  const { width = 900, height = 900 } = await sharp(small).metadata();
  const marks = LINES.map((f, i) => {
    const y = Math.round(f * height);
    return `<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="#ff2d2d" stroke-width="1.5" opacity="0.85"/>
      <text x="6" y="${y - 2}" font-family="Arial" font-size="15" font-weight="700" fill="#ff2d2d" stroke="#fff" stroke-width="3" paint-order="stroke">${i + 1}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${marks}</svg>`);
  const out = await sharp(small).composite([{ input: svg, top: 0, left: 0 }]).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

const PROMPT = `This is one photo for a clothing catalog, with numbered red lines drawn across it (line 1 near the top … line 30 at 60 % of the height).

1. "view": which side of the GARMENT does the photo show?
   - "front": the front of the garment (worn on a person facing the camera, on a hanger or laid flat)
   - "back": the back of the garment (a person's back to the camera, or the garment turned over)
   - "general": anything else — a close-up of a detail, a label, fabric, a side view, an accessory, several items
2. "headLine": if a PERSON'S HEAD (face, chin or hair) shows at the top of the photo, the number of the red line that runs just BELOW THE CHIN (on a back view: just below where the head meets the neck), so cutting there removes only the head and keeps the neck, the collar and the whole garment. The line must never cut into the garment or its collar. No head, a mannequin without a head, or a garment with no person: null.

JSON only: {"view": "front"|"back"|"general", "headLine": number|null}`;

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { url?: unknown };
  const url = s(body.url);
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
    const turn = turns.get(1) ?? 0;
    if (turn) img = await sharp(img).rotate(turn).toBuffer();

    // 2 + 3. View and head line, on the upright photo.
    const c = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 60,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You sort clothing catalog photos. Output valid JSON only." },
        { role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: await linedCopy(img), detail: "high" } }] },
      ],
    });
    const j = JSON.parse(s(c.choices?.[0]?.message?.content) || "{}") as { view?: unknown; headLine?: unknown };
    const view = j.view === "front" || j.view === "back" ? j.view : "general";
    const line = Number(j.headLine);
    let headCut = false;
    if (Number.isInteger(line) && line >= 1 && line <= LINES.length) {
      const meta = await sharp(img).metadata();
      const h = meta.height ?? 0;
      const top = Math.round(LINES[line - 1] * h);
      if (h && top > 0 && h - top > h * 0.35) {
        img = await sharp(img).extract({ left: 0, top, width: meta.width ?? 0, height: h - top }).toBuffer();
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
