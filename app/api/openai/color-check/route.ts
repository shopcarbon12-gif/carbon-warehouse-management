/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Read one photo of a colourway and say two things: what colour it is, and
 * whether anything in it contradicts the product spec we already hold.
 *
 * Deliberately narrow. The matrix spec was built from the full photo set and is
 * authoritative about construction, text, placement and the zone map — none of
 * which change with the dye. Re-analysing from one phone photo would replace a
 * good spec with a worse one. So this looks at colour and finish only.
 *
 * The second question earns its keep: a colourway is not always only a colour.
 * Black trousers often carry a black zip where the grey ones carry silver, and
 * nobody notices until the render comes back with the wrong hardware.
 *
 *   POST { colorRef: <url|data url>, itemSpec?: string, itemType?: string, colorLabel?: string }
 *     → { colorName, colorDetail, hardwareNote, contradicts }
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

const TIMEOUT_MS = 60_000;

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
    return `data:${text(contentType) || "image/jpeg"};base64,${bytes.toString("base64")}`;
  }
  const { bytes, contentType } = await fetchRemoteImageBytes(normalizeRemoteImageUrl(url), {
    timeoutMs: getImageFetchTimeoutMs(),
    maxBytes: getImageFetchMaxBytes(),
  });
  return `data:${text(contentType) || "image/jpeg"};base64,${bytes.toString("base64")}`;
}

export async function POST(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  try {
    const body = await req.json().catch(() => ({}));
    const colorRef = text(body?.colorRef);
    if (!colorRef) return NextResponse.json({ error: "colorRef required" }, { status: 400 });
    const itemSpec = text(body?.itemSpec).slice(0, 4000);
    const itemType = text(body?.itemType) || "apparel item";
    const colorLabel = text(body?.colorLabel).slice(0, 120);

    const apiKey = text(getOpenAiApiKey());
    if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

    let image = "";
    try {
      image = await toDataUrl(colorRef);
    } catch (e: any) {
      return NextResponse.json({ error: `Colour photo could not be loaded: ${e?.message || "unknown"}` }, { status: 400 });
    }
    if (!image) return NextResponse.json({ error: "Colour photo could not be loaded." }, { status: 400 });

    const instruction = [
      `This is one photograph of a ${itemType} in a colourway we are about to render.`,
      colorLabel ? `The catalogue calls this colour "${colorLabel}".` : "",
      "",
      "Answer two questions and nothing else.",
      "",
      "1. WHAT COLOUR IS THE GARMENT? Name it the way a buyer would — \"deep navy blue\", \"washed sand beige\", \"charcoal grey with a faint marl\". Then describe it precisely enough to mix it: lightness, saturation, any undertone, and whether the cloth reads flat or has a marl or weave showing through.",
      "   Judge the garment, not the lighting. A photo taken under warm indoor light makes everything yellower and a photo in shade makes it bluer; correct for that and say what the cloth is in neutral daylight. If the photograph is too dark, blown out or colour-cast to be sure, say so in \"uncertain\" rather than guessing a shade.",
      "",
      "2. DOES ANYTHING HERE CONTRADICT THE SPEC BELOW? A colourway is sometimes not only a colour: the zip, buttons, rivets, topstitching or label may be a different finish on this one. Report ONLY a clear, visible disagreement with a line of the spec, and only about colour or finish.",
      "   Construction, placement, text, pockets and the zone map are NOT your business — they were read off the full photo set and this single photo cannot overturn them. Say nothing about them.",
      "   If nothing disagrees, return an empty string for hardware_note and false for contradicts. That is the expected answer.",
      "",
      itemSpec ? `PRODUCT SPEC ON FILE:\n${itemSpec}` : "(No spec on file — answer question 1 only.)",
      "",
      "Return JSON only:",
      '{ "color_name": string, "color_detail": string, "uncertain": string, "hardware_note": string, "contradicts": boolean }',
    ]
      .filter(Boolean)
      .join("\n");

    const model = (process.env.ITEM_SPEC_MODEL || "gpt-4o").trim() || "gpt-4o";
    const client = new OpenAI({ apiKey });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let raw = "";
    try {
      const completion = await client.chat.completions.create(
        {
          model,
          temperature: 0.1,
          max_tokens: 500,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: "You match apparel colour for reproduction. You answer only about colour and finish. Output valid JSON only.",
            },
            {
              role: "user",
              content: [
                { type: "text", text: instruction },
                { type: "image_url", image_url: { url: image, detail: "high" } },
              ] as any,
            },
          ],
        },
        { signal: ac.signal },
      );
      raw = text(completion.choices?.[0]?.message?.content);
    } finally {
      clearTimeout(timer);
    }

    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          parsed = JSON.parse(m[0]);
        } catch {
          parsed = null;
        }
      }
    }
    if (!parsed || typeof parsed !== "object") {
      return NextResponse.json({ error: "Colour check returned no usable result. Please retry." }, { status: 502 });
    }

    const colorName = text(parsed.color_name).slice(0, 120);
    if (!colorName) {
      return NextResponse.json(
        { error: "The colour could not be read from that photo. Try a clearer, better-lit shot of the garment." },
        { status: 422 },
      );
    }
    return NextResponse.json({
      colorName,
      colorDetail: text(parsed.color_detail).slice(0, 400),
      uncertain: text(parsed.uncertain).slice(0, 300),
      hardwareNote: text(parsed.hardware_note).slice(0, 600),
      contradicts: parsed.contradicts === true,
      model,
    });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "Colour check timed out." : e?.message || "Colour check failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
