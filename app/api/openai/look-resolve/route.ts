import { withActivity } from "@/lib/server/activity-log";
/**
 * Carbon Studio: turn the styling words of an item instruction ("STYLE IT
 * DRESSY FULL OUTFIT", "style with oversized streetwear tshirt and black
 * sneakers") into concrete pieces for the run's LOOK SHEET.
 *
 * Without this, each of the four panels — separate image calls that never see
 * each other — invented its own "dressy outfit" from the same words. Resolved
 * once here, the pieces are named in the look sheet and every panel wears the
 * same ones. Text only, temperature 0, the cheap text model; the Studio calls
 * it once per run, only when lib/studioLookSheet.ts instructionHasStyling()
 * finds styling words, and caches the answer per (instruction, item type,
 * gender, colour).
 *
 * Body: { instruction, itemType, gender, itemColour?, productName? }
 * Returns { styling: ResolvedStyling | null } — null when the instruction asks
 * for no styling (it may only talk about the product itself).
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { text } from "@/lib/server/item-spec-build";
import type { OutfitSlot } from "@/lib/panelGeneration";
import { instructionHasStyling, withoutChoiceWords, type ResolvedStyling } from "@/lib/studioLookSheet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 30_000;
const SLOTS: OutfitSlot[] = ["top", "top_under", "bottom", "outerwear", "footwear", "accessories"];
const TUCKS = new Set(["tucked", "untucked", "front-tucked"]);

function instruction(args: { note: string; itemType: string; gender: string; itemColour: string; productName: string }): string {
  return `A store owner wrote a note for a catalog photo shoot. Turn the STYLING in it into concrete clothes.

THE PRODUCT being sold: a ${args.itemType}${args.productName ? ` ("${args.productName}")` : ""}${args.itemColour ? ` in ${args.itemColour}` : ""}, worn by a ${args.gender} model.
THE NOTE: "${args.note}"

The note may also talk about the product itself — its fit, length, how open it is, its rips, its fabric. That is NOT styling: leave it out. Only the OTHER pieces the model wears with the product count.

Reply with JSON:
{"styling": null} when the note asks for no other piece and changes none, otherwise
{"styling": {"slots": {...}, "adjust": {...}, "explicit": [...], "tuck": "..."}} where
- "slots": a NEW piece the note asks for or clearly implies, per slot: "top", "top_under" (under an open jacket), "bottom", "outerwear", "footwear", "accessories". ONE line each, naming ONE concrete piece: colour, garment, cut / fit and length; for a top also sleeve length and neckline; for shoes also the sole colour and lace colour; the fabric look. Plain — no print, no text, no logo — unless the note asks for one. "accessories" is one complete list of every accessory, e.g. "a slim black leather belt with a small silver buckle". If the note points at a piece already in the photos ("use the tank top", "keep same shoes"), the value is "the <piece> shown in the item photos". "Style it dressy / full outfit" implies the slots the product leaves empty, nothing more.
- "adjust": a change the note makes to a piece without replacing it, per slot, as a few words, e.g. "shirt is oversized" → {"top": "oversized"}.
- "explicit": the slots whose piece the note NAMES outright ("black sneakers", "white shirt") — not the ones you inferred.
- "tuck": "tucked" | "untucked" | "front-tucked", only if the note says how the top is worn.
Never fill a slot the product itself occupies (a ${args.itemType} is the product). Never offer alternatives: no "or", no "/", one piece per slot. Leave out every key you do not need.`;
}

/** The model's answer, reduced to what resolveLookSheet accepts. */
function sanitize(raw: unknown): ResolvedStyling | null {
  const s = (raw && typeof raw === "object" ? (raw as { styling?: unknown }).styling : null) as Record<string, unknown> | null;
  if (!s || typeof s !== "object") return null;
  const lineOf = (v: unknown) => withoutChoiceWords(text(v).replace(/\s+/g, " ").replace(/[.;,\s]+$/, "")).slice(0, 300);
  const readSlots = (v: unknown) => {
    const out: Partial<Record<OutfitSlot, string>> = {};
    if (!v || typeof v !== "object") return out;
    for (const slot of SLOTS) {
      const line = lineOf((v as Record<string, unknown>)[slot]);
      if (line && !/^(?:none|null|n\/a)$/i.test(line)) out[slot] = line;
    }
    return out;
  };
  const slots = readSlots(s.slots);
  const adjust = readSlots(s.adjust);
  const explicit = (Array.isArray(s.explicit) ? s.explicit : [])
    .map((x) => text(x).toLowerCase() as OutfitSlot)
    .filter((x) => SLOTS.includes(x) && Boolean(slots[x]));
  const tuck = text(s.tuck).toLowerCase();
  const styling: ResolvedStyling = {
    ...(Object.keys(slots).length ? { slots } : {}),
    ...(Object.keys(adjust).length ? { adjust } : {}),
    ...(explicit.length ? { explicit: [...new Set(explicit)] } : {}),
    ...(TUCKS.has(tuck) ? { tuck: tuck as ResolvedStyling["tuck"] } : {}),
  };
  return Object.keys(styling).length ? styling : null;
}

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const note = text(body.instruction).replace(/\s+/g, " ").slice(0, 1200);
  if (!note || !instructionHasStyling(note)) return NextResponse.json({ styling: null });
  const itemType = text(body.itemType).slice(0, 80) || "garment";
  const gender = text(body.gender).toLowerCase() === "female" ? "female" : "male";
  const itemColour = text(body.itemColour).slice(0, 80);
  const productName = text(body.productName).replace(/"/g, "'").slice(0, 120);
  const apiKey = text(getOpenAiApiKey());
  if (!apiKey) return NextResponse.json({ error: "Missing OPENAI_API_KEY" }, { status: 500 });

  const client = new OpenAI({ apiKey });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const completion = await client.chat.completions.create(
      {
        model: (process.env.STUDIO_LOOK_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini",
        temperature: 0,
        max_tokens: 600,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a fashion stylist writing exact outfit lists for an image generator. Output valid JSON only." },
          { role: "user", content: instruction({ note: note.replace(/"/g, "'"), itemType, gender, itemColour, productName }) },
        ],
      },
      { signal: ac.signal },
    );
    const raw = text(completion.choices?.[0]?.message?.content);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    return NextResponse.json({ styling: sanitize(parsed) });
  } catch (e) {
    const msg =
      e instanceof Error && e.name === "AbortError"
        ? "Reading the styling in the item instruction timed out."
        : e instanceof Error
          ? e.message
          : "Reading the styling in the item instruction failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}

export const POST = withActivity("openai/look-resolve", POST_handler);
