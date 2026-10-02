/**
 * Phone side of the AI reading: draw the grid, send the picture, and turn the
 * answer into a garment cut-out and lines. See ai-lines.ts for the reasoning.
 */
import { drawAiGrid } from "./ai-grid";
import { aiLinesOnMask, disagreesWithAi, maskFromAi, snapAiLines, type AiReading } from "./ai-lines";
import { ALL_POMS, type GarmentType, type PomKey } from "./garment";
import type { Segment, ShirtMask } from "./measure";
import { cutSheet } from "./model-segment";
import { garmentCheck } from "./find-garment";
import type { Quad, RectFrame } from "./target";

const SIDE_ONLY: Record<"front" | "back", ReadonlySet<string>> = {
  front: new Set(["backPocketWidth", "backPocketLength"]),
  back: new Set(["frontPocketOpening"]),
};

/** Every point that can exist on this side — the family may not be known yet. */
export function aiKeysFor(type: GarmentType | null, view: "front" | "back", known: PomKey[]): PomKey[] {
  if (type) return known;
  return ALL_POMS.filter((k) => !SIDE_ONLY[view].has(k));
}

export async function readWithAi(
  picture: ImageData,
  type: GarmentType | null,
  view: "front" | "back",
  keys: PomKey[],
  signal?: AbortSignal,
): Promise<AiReading> {
  const gridded = drawAiGrid(picture.data, picture.width, picture.height);
  const canvas = document.createElement("canvas");
  canvas.width = picture.width;
  canvas.height = picture.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");
  const img = new ImageData(picture.width, picture.height);
  img.data.set(gridded);
  ctx.putImageData(img, 0, 0);
  const image = canvas.toDataURL("image/jpeg", 0.88);
  const r = await fetch("/api/inventory/size-grading/ai-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, type, view, keys }),
    signal,
  });
  const j = (await r.json().catch(() => ({}))) as { reading?: AiReading; error?: string };
  if (!r.ok || !j.reading) throw new Error(j.error || `the AI request failed (${r.status})`);
  return j.reading;
}

export type Chosen = {
  mask: ShirtMask | null;
  /** Which cut-out was used, in words for the status line. */
  how: string;
  /** The AI's lines, on the cut-out's edges when there is one — these are the measurement. */
  lines: Partial<Record<PomKey, Segment>>;
};

/**
 * The AI judges the quick model's cut-out; if it disagrees, the AI's own
 * seeds cut the garment out instead.
 */
export function chooseWithAi(
  ai: AiReading,
  quick: ShirtMask | null,
  picture: { data: Uint8ClampedArray; width: number; height: number },
  frame: RectFrame,
  src: { width: number; height: number },
  quad: Quad,
): Chosen {
  const quickWhy = quick ? (garmentCheck(quick, frame, src, quad) ?? disagreesWithAi(quick, ai)) : "it did not run";
  if (quick && !quickWhy) return { mask: quick, how: "the AI confirmed the cut-out", lines: aiLinesOnMask(ai, quick, frame.pxPerCm) };
  const own = maskFromAi(picture.data, picture.width, picture.height, frame.pxPerCm, ai);
  if (own) {
    cutSheet(own.data, own.width, own.height, frame);
    let area = 0;
    for (let i = 0; i < own.data.length; i++) area += own.data[i];
    own.area = area;
    const ownWhy = garmentCheck(own, frame, src, quad);
    if (!ownWhy) {
      return { mask: own, how: `the AI cut the garment out itself (the quick cut-out was rejected: ${quickWhy})`, lines: aiLinesOnMask(ai, own, frame.pxPerCm) };
    }
  }
  // No clean cut-out: the AI's lines, snapped onto the photo's own edges.
  const lines = snapAiLines(picture.data, picture.width, picture.height, frame.pxPerCm, ai);
  return { mask: null, how: `neither cut-out held up (${quickWhy}) — the lines are the AI's own`, lines };
}

/**
 * Which line each point is measured on.
 *
 * Measured on the owner's photos, two of the same leggings on different
 * tables: the outline's rows were consistent for the waist, hip, thigh and
 * the seams (they are built from the crotch it finds), and wrong on a leg
 * lying at an angle — a row cuts the hem's pointed corner (4.2 cm for a 10 cm
 * hem). The AI's lines run square across the leg, so for the lower leg and
 * the sleeve they are the better line once snapped onto the cut-out. For
 * points the outline cannot see at all (waistband height, pockets, neck) the
 * AI's line is the only one.
 */
const AI_FIRST = new Set<string>(["knee", "calf", "legOpening", "bicep", "cuff", "sleeve", "sleeveInseam"]);

export function mergeLines(
  outline: Partial<Record<PomKey, { line: Segment }>> | null,
  ai: Partial<Record<PomKey, Segment>> | null,
): Partial<Record<PomKey, Segment>> {
  const out: Partial<Record<PomKey, Segment>> = {};
  const keys = new Set<string>([...Object.keys(outline ?? {}), ...Object.keys(ai ?? {})]);
  for (const k of keys as Set<PomKey>) {
    const o = outline?.[k]?.line, a = ai?.[k];
    const pick = AI_FIRST.has(k) ? (a ?? o) : (o ?? a);
    if (pick) out[k] = { a: { ...pick.a }, b: { ...pick.b } };
  }
  /* The seams end at the hem's corners. When the hem is the AI's line (square
     across an angled leg), the outline's seams end on the row's pointed corner
     instead — so their bottom ends move to the hem line's nearer end. */
  const hem = ai?.legOpening ? out.legOpening : undefined; // legOpening is AI-first, so this is the AI's
  if (hem) {
    for (const k of ["inseam", "outseam"] as const) {
      const s = out[k];
      if (!s || !outline?.[k]) continue;
      const lowEnd = s.a.y > s.b.y ? "a" : "b";
      const p = s[lowEnd];
      const near = Math.hypot(hem.a.x - p.x, hem.a.y - p.y) <= Math.hypot(hem.b.x - p.x, hem.b.y - p.y) ? hem.a : hem.b;
      s[lowEnd] = { ...near };
    }
  }
  return out;
}
