import { withActivity } from "@/lib/server/activity-log";
/**
 * Bulk Studio: split one batch of photos into products (owner, 2026-10-20).
 *
 * The owner drops many photos of many products into one box, in shooting
 * order, with a photo of each product's hang tag. One cheap pass over small
 * copies of all of them decides which photos show the same product and which
 * are tags; each tag is then read at full detail and resolved to its product.
 * Photos before the first tag belong to the item they were dropped on.
 *
 * POST { images: [{ data } | { url }], current?: string }
 * → { photos: [{ group, isTag, sku?, matches? }] }   (same order as sent)
 */
import OpenAI from "openai";
import sharp from "sharp";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { downloadStorageObject, tryGetStoragePathFromUrl } from "@/lib/storageProvider";
import { readTagPhoto, resolveTagCode, type TagMatch } from "@/lib/server/hang-tag";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX = 80;
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function load(entry: { data?: unknown; url?: unknown }, tid: string): Promise<Buffer | null> {
  const data = s(entry.data);
  if (data.startsWith("data:image/")) return Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
  const path = tryGetStoragePathFromUrl(s(entry.url));
  if (!path || !(path.startsWith(`carbon-studio/item-refs/${tid}/`) || path.startsWith("carbon-studio/handoff/"))) return null;
  const { body } = await downloadStorageObject(path);
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

const jpeg = async (b: Buffer, size: number) =>
  `data:image/jpeg;base64,${(await sharp(b).autoOrient().resize(size, size, { fit: "inside" }).jpeg({ quality: 82 }).toBuffer()).toString("base64")}`;

function prompt(n: number, current: string) {
  return `These ${n} photos were taken in one session, IN THIS ORDER, of one or more clothing products for a store's catalog. Before photographing a product the owner usually photographs its HANG TAG (a small card with a barcode and a printed code).

For each photo decide:
- "tag": true only if the photo is mainly such a hang / price tag.
- "group": which product it belongs to, numbered 1, 2, 3… in order of appearance.
  · A tag photo of a product starts that product's group; the photos after it belong to it until the next tag or until the photos clearly switch to a DIFFERENT garment.
  · A clearly different garment with no tag before it also starts a new group.
  · Shoes, a shirt, a bracelet or other pieces shot to STYLE the product stay in the product's group.
  · ${current ? `Group 1 is RESERVED for "${current}", the item already open: photos of that garment (and pieces styling it) that come before any tag are group 1. If the first photos already show a DIFFERENT garment, they start group 2 — group 1 then stays empty.` : "Group 1 is the photos before any tag."}

JSON only: {"photos": [{"photo": 1, "group": 1, "tag": false}, …]} with one entry per photo.`;
}

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { images?: unknown; current?: unknown };
  const list = (Array.isArray(body.images) ? body.images : []).slice(0, MAX) as { data?: unknown; url?: unknown }[];
  if (!list.length) return NextResponse.json({ error: "images required" }, { status: 400 });
  const apiKey = s(getOpenAiApiKey());
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });
  const client = new OpenAI({ apiKey });
  const model = (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o";

  const bufs = await Promise.all(list.map((e) => load(e, session.tid).catch(() => null)));
  const small = await Promise.all(bufs.map((b) => (b ? jpeg(b, 512).catch(() => "") : Promise.resolve(""))));

  /* 1. One pass over all photos: groups and tags. */
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [{ type: "text", text: prompt(list.length, s(body.current)) }];
  small.forEach((u, i) => {
    content.push({ type: "text", text: `Photo ${i + 1}:` });
    if (u) content.push({ type: "image_url", image_url: { url: u, detail: "low" } });
    else content.push({ type: "text", text: "(could not be loaded)" });
  });
  let groups: number[] = list.map(() => 1);
  let tags: boolean[] = list.map(() => false);
  try {
    const c = await client.chat.completions.create({
      model,
      temperature: 0,
      max_tokens: 40 + list.length * 25,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You sort clothing catalog photos by product. Output valid JSON only." },
        { role: "user", content },
      ],
    });
    const j = JSON.parse(s(c.choices?.[0]?.message?.content) || "{}") as { photos?: Array<{ photo?: unknown; group?: unknown; tag?: unknown }> };
    for (const p of j.photos ?? []) {
      const i = Number(p.photo) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= list.length) continue;
      const g = Number(p.group);
      if (Number.isInteger(g) && g >= 1) groups[i] = g;
      tags[i] = p.tag === true;
    }
  } catch (e) {
    console.error("[studio/group-photos] grouping", e);
    groups = list.map(() => 1);
    tags = list.map(() => false);
  }

  /* 2. Read each tag at full detail and find its product. */
  const out: { group: number; isTag: boolean; sku?: string; matches?: TagMatch[] }[] = groups.map((g) => ({ group: g, isTag: false }));
  await Promise.all(
    tags.map(async (isTag, i) => {
      if (!isTag || !bufs[i]) return;
      try {
        const t = await readTagPhoto(client, model, await jpeg(bufs[i] as Buffer, 1600));
        if (!t.isTag) return;
        out[i] = { group: groups[i], isTag: true, sku: t.sku || t.upc, matches: await resolveTagCode(pool, t.sku, t.upc) };
      } catch {
        /* an unreadable tag stays a normal photo of its group */
      }
    }),
  );
  return NextResponse.json({ photos: out });
}

export const POST = withActivity("studio/group-photos", POST_handler);
