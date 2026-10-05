import { withActivity } from "@/lib/server/activity-log";
/**
 * Size Grading — ask a vision model to read the garment.
 *
 * The phone sends the squared-up picture with the coordinate grid already
 * drawn on it; this adds the prompt and the key, and returns the model's
 * reading untouched. Snapping its lines onto the garment's real edges happens
 * on the phone (lib/size-grading/ai-lines.ts), against the full-resolution
 * picture this route never needs to see.
 *
 * Model: SIZE_GRADING_AI_MODEL (default gpt-5.4), SIZE_GRADING_AI_EFFORT
 * (default none). The AI only says which object is the garment (type, box,
 * points on and off it) and places what an outline cannot see — waistband,
 * pockets, neck; the outline measures the rest. Measured on the owner's
 * photos: gpt-5.5 thinking cost ~3.7¢ a photo, gpt-5.4 without thinking
 * ~1.2¢ and ~4 s with the same answers on those jobs. gpt-5.4-mini and
 * gpt-4.1 put the garment on the table — do not downgrade without testing.
 * And it is only called when the phone's own cut-out fails its checks.
 */
import OpenAI from "openai";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { ALL_POMS, type GarmentType } from "@/lib/size-grading/garment";
import { buildAiPrompt } from "@/lib/size-grading/ai-prompt";

export const runtime = "nodejs";

const TIMEOUT_MS = 60_000;
/** A 1400 px JPEG is ~300 kB; this leaves room and refuses anything silly. */
const MAX_DATA_URL = 4_000_000;

const Body = z.object({
  image: z.string().startsWith("data:image/").max(MAX_DATA_URL),
  type: z.enum(["top", "trousers", "shorts", "dress", "skirt", "onepiece"]).nullable().optional(),
  view: z.enum(["front", "back"]).default("front"),
  keys: z.array(z.enum(ALL_POMS)).max(ALL_POMS.length),
});

const Pt = z.tuple([z.number(), z.number()]);
const Reading = z.object({
  garment: z.string(),
  description: z.string().optional(),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  on: z.array(Pt).default([]),
  off: z.array(Pt).default([]),
  lines: z.record(z.string(), z.object({ a: Pt, b: Pt }).nullable()).default({}),
});

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { image, type, view, keys } = parsed.data;

  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) return NextResponse.json({ error: "The AI is not configured on this server (no OpenAI key)." }, { status: 503 });

  const model = (process.env.SIZE_GRADING_AI_MODEL || "gpt-5.4").trim();
  const effort = (process.env.SIZE_GRADING_AI_EFFORT || "none").trim() as "none" | "low" | "medium";
  const client = new OpenAI({ apiKey });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await client.responses.create(
      {
        model,
        ...(model.startsWith("gpt-5") ? { reasoning: { effort } } : {}),
        text: { format: { type: "json_object" } },
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: buildAiPrompt(keys, (type ?? null) as GarmentType | null, view) },
              { type: "input_image", image_url: image, detail: "high" },
            ],
          },
        ],
      },
      { signal: ac.signal },
    );
    const raw = res.output_text ?? "";
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) json = JSON.parse(m[0]);
    }
    const reading = Reading.safeParse(json);
    if (!reading.success) {
      return NextResponse.json({ error: "The AI's answer could not be read. Try again." }, { status: 502 });
    }
    return NextResponse.json({ reading: reading.data, model, ms: Date.now() - started });
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    const msg = aborted ? "The AI took too long to answer." : e instanceof Error ? e.message : "The AI request failed.";
    return NextResponse.json({ error: msg }, { status: aborted ? 504 : 502 });
  } finally {
    clearTimeout(timer);
  }
}

export const POST = withActivity("inventory/size-grading/ai-read", POST_handler);
