/**
 * Phone side of the AI reading: draw the grid, send the picture, and turn the
 * answer into a garment cut-out and lines. See ai-lines.ts for the reasoning.
 */
import { drawAiGrid } from "./ai-grid";
import { aiLinesOnMask, disagreesWithAi, maskFromAi, snapAiLines, type AiReading } from "./ai-lines";
import { ALL_POMS, POM_SOURCE, type GarmentType, type PomKey } from "./garment";
import type { Segment, ShirtMask } from "./measure";
import { cutSheet } from "./model-segment";
import { garmentCheck } from "./find-garment";
import type { Quad, RectFrame } from "./target";

const SIDE_ONLY: Record<"front" | "back", ReadonlySet<string>> = {
  front: new Set(["backPocketWidth", "backPocketLength"]),
  back: new Set(["frontPocketOpening"]),
};

/**
 * The points the AI is asked to place: only those the outline cannot measure
 * (waistband height, pockets, neck…). Everything else is measured off the
 * cut-out, square across the garment — asking the AI for those lines too cost
 * two-thirds of every call and they were the lines it got wrong.
 */
export function aiKeysFor(type: GarmentType | null, view: "front" | "back", known: PomKey[]): PomKey[] {
  const pool = type ? known : ALL_POMS.filter((k) => !SIDE_ONLY[view].has(k));
  return pool.filter((k) => POM_SOURCE[k] === "manual");
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
  const quickWhy = quick ? (garmentCheck(quick, frame, src, quad) ?? disagreesWithAi(quick, ai, frame.pxPerCm)) : "it did not run";
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
 * Which line each point is measured on: the outline's, measured off the
 * cut-out — widths square across the leg, seams to the hem's corners — and the
 * AI's only for the points the outline cannot see.
 */
export function mergeLines(
  outline: Partial<Record<PomKey, { line: Segment }>> | null,
  ai: Partial<Record<PomKey, Segment>> | null,
): Partial<Record<PomKey, Segment>> {
  const out: Partial<Record<PomKey, Segment>> = {};
  for (const [k, p] of Object.entries(outline ?? {})) if (p) out[k as PomKey] = { a: { ...p.line.a }, b: { ...p.line.b } };
  for (const [k, l] of Object.entries(ai ?? {})) if (l && !out[k as PomKey]) out[k as PomKey] = { a: { ...l.a }, b: { ...l.b } };
  return out;
}
