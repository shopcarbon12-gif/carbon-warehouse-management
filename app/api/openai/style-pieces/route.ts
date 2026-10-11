import { withActivity } from "@/lib/server/activity-log";
/**
 * Carbon Studio "Style with": name the pieces in the operator's style-with
 * photos (a shirt, shoes, a bracelet) so the styling lock can name them.
 *
 * The four panels of a run are separate image calls that cannot see each
 * other. A piece the prompt only points at ("the shirt in image 7") was
 * outvoted by the lock's named default tee and never worn; a piece NAMED in
 * the lock — the same words in every panel — is. One vision call per run.
 *
 * Returns { outfit: { top?, top_under?, bottom?, outerwear?, footwear?, accessories? } }.
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import {
  assertDataUrlSize,
  fetchRemoteImageBytes,
  getImageFetchMaxBytes,
  getImageFetchTimeoutMs,
  normalizeRemoteImageUrl,
} from "@/lib/remoteImage";
import { downloadStorageObject, tryGetStoragePathFromUrl } from "@/lib/storageProvider";
import { text } from "@/lib/server/item-spec-build";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REFS = 6;
const TIMEOUT_MS = 60_000;
const SLOTS = ["top", "top_under", "bottom", "outerwear", "footwear", "accessories"] as const;

async function toDataUrl(rawUrl: string): Promise<string> {
  const url = text(rawUrl);
  if (!url) return "";
  if (url.startsWith("data:image/")) {
    assertDataUrlSize(url, getImageFetchMaxBytes());
    return url;
  }
  const storagePath = tryGetStoragePathFromUrl(url);
  if (storagePath) {
    const { body, contentType } = await downloadStorageObject(storagePath);
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (bytes.length > getImageFetchMaxBytes()) throw new Error(`Image too large (${bytes.length} bytes).`);
    return `data:${text(contentType) || "image/png"};base64,${bytes.toString("base64")}`;
  }
  const { bytes, contentType } = await fetchRemoteImageBytes(normalizeRemoteImageUrl(url), {
    timeoutMs: getImageFetchTimeoutMs(),
    maxBytes: getImageFetchMaxBytes(),
  });
  return `data:${text(contentType) || "image/png"};base64,${bytes.toString("base64")}`;
}

function instruction(itemType: string): string {
  return `These photos show clothing, footwear and/or accessories that a model will WEAR in a fashion catalog shoot, together with a different product (a ${itemType}). An image generator must reproduce each piece exactly from your words.

Describe each piece once. Several photos of one piece (its front and its back, or a detail) are ONE piece. Ignore any person, mannequin, hanger, packaging and background — describe only the clothes and accessories. If a ${itemType} appears, do not describe it (it is the product, shown elsewhere).

Return JSON with only the slots that a photo actually shows:
- "top": the main top (t-shirt, shirt, tank, polo, sweater, hoodie)
- "top_under": a top worn under an open jacket or overshirt
- "bottom": trousers, jeans, shorts, skirt
- "outerwear": a jacket, coat, blazer or overshirt worn over a top
- "footwear": the shoes
- "accessories": every accessory in one line (belt, bracelet, chain, watch, cap, bag, sunglasses)

Each value is ONE line of at most 40 words, in this order: colour, garment, cut / fit and length, fabric and texture, then any print, text (exact spelling, in quotes), graphic, logo, buttons or hardware and where they sit, and how it is worn (open, tucked, sleeves rolled) if the photo shows it. Plain words, no brand guesses. Example: {"top": "cream relaxed-fit short-sleeve linen camp-collar shirt, boxy and hip length, slubby linen texture, five white buttons down the front, worn open over nothing"}`;
}

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { urls?: unknown; itemType?: unknown };
  const urls = (Array.isArray(body.urls) ? body.urls : []).map(text).filter(Boolean).slice(0, MAX_REFS);
  if (!urls.length) return NextResponse.json({ error: "urls required" }, { status: 400 });
  const itemType = text(body.itemType) || "garment";
  const apiKey = text(getOpenAiApiKey());
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

  const loaded = (await Promise.allSettled(urls.map(toDataUrl)))
    .filter((r): r is PromiseFulfilledResult<string> => r.status === "fulfilled" && !!r.value)
    .map((r) => r.value);
  if (!loaded.length) return NextResponse.json({ error: "None of the Style with photos could be loaded." }, { status: 400 });

  const client = new OpenAI({ apiKey });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const completion = await client.chat.completions.create(
      {
        model: (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o",
        temperature: 0.1,
        max_tokens: 700,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You describe clothing for exact reproduction by an image generator. Output valid JSON only." },
          {
            role: "user",
            content: [
              { type: "text", text: instruction(itemType) },
              ...loaded.map((url) => ({ type: "image_url" as const, image_url: { url, detail: "high" as const } })),
            ],
          },
        ],
      },
      { signal: ac.signal },
    );
    const raw = text(completion.choices?.[0]?.message?.content);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }
    const outfit: Partial<Record<(typeof SLOTS)[number], string>> = {};
    for (const s of SLOTS) {
      const v = text(parsed[s]).replace(/\s+/g, " ").slice(0, 400);
      if (v) outfit[s] = v.replace(/\.$/, "");
    }
    if (!Object.keys(outfit).length) {
      return NextResponse.json({ error: "Could not tell what the Style with photos show. Try clearer photos of each piece." }, { status: 422 });
    }
    return NextResponse.json({ outfit, imagesAnalyzed: loaded.length });
  } catch (e) {
    const msg = e instanceof Error && e.name === "AbortError" ? "Reading the Style with photos timed out." : e instanceof Error ? e.message : "Reading the Style with photos failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}

export const POST = withActivity("openai/style-pieces", POST_handler);
