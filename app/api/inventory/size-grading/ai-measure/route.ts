import OpenAI from "openai";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { assertDataUrlSize, getImageFetchMaxBytes } from "@/lib/remoteImage";
import { ALL_POMS, GARMENT_LABELS, POMS_FOR, POM_LABEL, type GarmentType, type PomKey } from "@/lib/size-grading/garment";
import { pomHowTo, pomOnSide } from "@/lib/size-grading/pom-guide";

/**
 * Size Grading: look at the photo and place every measurement line.
 *
 * The silhouette code in lib/size-grading can only find what a clean outline
 * gives it — on a dark garment on a dark table it finds very little, and the
 * operator ends up placing every line by hand. A vision model sees a pair of
 * leggings the way a person does: it knows where the waistband is, where the
 * crotch seam is, which way is up, and that the black-framed sheet is a
 * calibration target and not a pocket.
 *
 * The model only says WHERE each line goes. The number is still computed on
 * the page, from the squared-up photo's exact px-per-cm, so a model that is a
 * few pixels out is a few millimetres out — and the operator can drag either
 * end to correct it. Nothing is saved from here.
 *
 * POST { image: dataURL, view, garmentType?, itemName?, category? }
 *   → { garmentType, detectedView, points: [{ key, visible, a: {x,y}, b: {x,y} }], notes, model }
 *   Coordinates are fractions of the image (0–1), so the page does not have to
 *   agree with the server about what size the image was.
 *
 * Model: OPENAI_SIZE_GRADING_MODEL, else gpt-5, falling back to gpt-4o when
 * the account cannot use the first choice.
 */

export const maxDuration = 120;

const GARMENT_TYPES = Object.keys(GARMENT_LABELS) as GarmentType[];

const Body = z.object({
  image: z.string().startsWith("data:image/"),
  view: z.enum(["front", "back"]).default("front"),
  garmentType: z.enum(GARMENT_TYPES as [GarmentType, ...GarmentType[]]).optional(),
  itemName: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
});

/* Strict structured output: every property required, nothing extra. One flat
   row per point keeps the schema small enough for every model that supports it. */
const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["garmentType", "detectedView", "points", "notes"],
  properties: {
    garmentType: { type: "string", enum: GARMENT_TYPES },
    detectedView: { type: "string", enum: ["front", "back", "unsure"] },
    notes: { type: "string" },
    points: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "visible", "ax", "ay", "bx", "by"],
        properties: {
          key: { type: "string", enum: [...ALL_POMS] },
          visible: { type: "boolean" },
          ax: { type: "integer" },
          ay: { type: "integer" },
          bx: { type: "integer" },
          by: { type: "integer" },
        },
      },
    },
  },
} as const;

type ModelOut = {
  garmentType: GarmentType;
  detectedView: "front" | "back" | "unsure";
  notes: string;
  points: Array<{ key: PomKey; visible: boolean; ax: number; ay: number; bx: number; by: number }>;
};

function pointGuide(type: GarmentType, view: "front" | "back"): string {
  return POMS_FOR[type]
    .filter((k) => pomOnSide(k, view))
    .map((k) => `  - ${k} (${POM_LABEL[k]}): ${pomHowTo(k, type)}`)
    .join("\n");
}

function buildPrompt(b: z.infer<typeof Body>): string {
  const known = b.garmentType
    ? `The catalogue says this is: ${GARMENT_LABELS[b.garmentType]} (${b.garmentType}). Use that unless the photo plainly shows something else.`
    : "The garment family is not known — decide it from the photo.";
  const families = (b.garmentType ? [b.garmentType] : GARMENT_TYPES)
    .map((t) => `${t} — ${GARMENT_LABELS[t]}:\n${pointGuide(t, b.view)}`)
    .join("\n\n");

  return [
    "You are an apparel technical designer taking flat garment measurements (points of measure) from a photo.",
    "The photo is taken from straight above. A garment lies flat on a table. It has already been geometrically",
    "corrected so the table surface is square to the camera. A printed calibration target — a sheet of white paper",
    "with a thick black rectangular frame — is somewhere in the photo. It is NOT part of the garment: ignore it.",
    "Ignore anything else that is not the garment (chairs, floor, hands, shadows).",
    "",
    known,
    b.itemName ? `Item name: ${b.itemName}.` : "",
    b.category ? `Catalogue category: ${b.category}.` : "",
    `The operator says the garment is lying ${b.view === "front" ? "FRONT side up" : "BACK side up"}.`,
    "",
    "For each point of measure of the garment family, return the two END POINTS of the measuring line.",
    "Rules:",
    "- Coordinates are integers on a 0–1000 grid for EACH axis: x=0 is the left edge of the image, x=1000 the right",
    "  edge; y=0 the top edge, y=1000 the bottom edge.",
    "- A width (waist, hip, chest, hem, thigh, knee, calf, leg opening, cuff, bicep) is measured straight across the",
    "  garment as it lies, perpendicular to that part of the garment. Both ends must sit EXACTLY on the garment's",
    "  outer edge — not inside the fabric, not out on the table. Look closely at where the fabric meets the table.",
    "- A length runs along the garment between the two landmarks described. Ends sit exactly on those landmarks.",
    "- The garment may be rotated or not centred; follow the garment, not the image axes.",
    "- If the point cannot be seen in this photo (for example a pocket that is on the other side, a garment with no",
    "  pockets, a part folded under), set visible=false and give your best guess or zeros for the coordinates.",
    "- Return every point listed for the family you choose, in any order.",
    "",
    "Points of measure by family:",
    families,
    "",
    "detectedView: whether the photo shows the front or the back of the garment (back pockets, no fly, a label at",
    "the back neck mean back), or unsure. notes: one short sentence about anything that limits accuracy, or empty.",
  ]
    .filter((l) => l !== undefined)
    .join("\n");
}

const isReasoningModel = (m: string) => /^(gpt-5|o\d)/.test(m);

async function ask(client: OpenAI, model: string, prompt: string, image: string): Promise<ModelOut> {
  const response = await client.responses.create({
    model,
    ...(isReasoningModel(model) ? { reasoning: { effort: "low" as const } } : { temperature: 0 }),
    max_output_tokens: isReasoningModel(model) ? 12000 : 3000,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: image, detail: "high" },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "garment_points",
        strict: true,
        schema: RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      },
    },
  });
  const raw = (response.output_text || "").trim();
  if (!raw) throw new Error("The model returned nothing.");
  return JSON.parse(raw) as ModelOut;
}

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const b = parsed.data;
  try {
    assertDataUrlSize(b.image, getImageFetchMaxBytes());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Image too large" }, { status: 413 });
  }

  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) {
    return NextResponse.json({ error: "OpenAI is not configured on the server (OPENAI_API_KEY)." }, { status: 503 });
  }
  const client = new OpenAI({ apiKey });
  const prompt = buildPrompt(b);

  const preferred = (process.env.OPENAI_SIZE_GRADING_MODEL || "").trim() || "gpt-5";
  const models = [...new Set([preferred, "gpt-4o"])];
  let out: ModelOut | null = null;
  let used = "";
  let lastErr: unknown = null;
  for (const model of models) {
    try {
      out = await ask(client, model, prompt, b.image);
      used = model;
      break;
    } catch (e) {
      lastErr = e;
      /* Only an unusable model is worth a second try; a refused image or a
         network failure would fail the same way twice. */
      const status = (e as { status?: number }).status;
      const code = String((e as { code?: string }).code ?? "");
      const modelProblem = status === 404 || status === 403 || /model/i.test(code) || /model/i.test(String((e as Error).message));
      if (!modelProblem) break;
    }
  }
  if (!out) {
    const msg = lastErr instanceof Error ? lastErr.message : "The vision model did not answer.";
    return NextResponse.json({ error: `AI placement failed: ${msg}` }, { status: 502 });
  }

  const type: GarmentType = GARMENT_TYPES.includes(out.garmentType) ? out.garmentType : (b.garmentType ?? "top");
  const wanted = new Set<string>(POMS_FOR[type]);
  const clamp = (v: number) => Math.max(0, Math.min(1000, Number.isFinite(v) ? v : 0)) / 1000;
  const seen = new Set<string>();
  const points = out.points
    .filter((p) => wanted.has(p.key) && !seen.has(p.key) && seen.add(p.key))
    .map((p) => {
      const a = { x: clamp(p.ax), y: clamp(p.ay) };
      const bb = { x: clamp(p.bx), y: clamp(p.by) };
      // A zero-length line is the model saying "nowhere", whatever `visible` says.
      const visible = p.visible && Math.hypot(a.x - bb.x, a.y - bb.y) > 0.004;
      return { key: p.key, visible, a, b: bb };
    });

  return NextResponse.json({
    garmentType: type,
    detectedView: out.detectedView,
    points,
    notes: out.notes ?? "",
    model: used,
  });
}
