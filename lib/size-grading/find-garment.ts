/**
 * Find the garment in a squared-up photo — and know when the answer is wrong.
 *
 * WHY TWO MODELS
 *
 * U²-Netp (model-segment.ts) finds "the main object in the picture". On a
 * garment on a plain sheet that is the garment. On the owner's second photo of
 * the same leggings, on the same dark round table, the main object was the
 * TABLE: 8,100 cm², lines drawn round its rim, reported as "garment found".
 * Nothing in a salience model can tell the two apart; what can is the one thing
 * this app knows exactly — real size, from the printed target:
 *
 *   - a flat garment is between ~400 and ~7,000 cm²; a table is not;
 *   - the target lies ON the surface and BESIDE the garment, so whatever
 *     covers the ground all round the target is the surface;
 *   - the whole garment is in frame, so a shape running off the photo is floor.
 *
 * When U²-Netp's answer passes those checks it is used (≈3 s). When it fails,
 * SlimSAM — a segment-anything model, which outlines EVERY object separately —
 * is prompted on a grid, and the checks choose among its outlines. It is
 * slower (~25 s single-threaded), so it runs only when needed.
 *
 * SlimSAM-77 (Xenova/slimsam-77-uniform, Apache-2.0), quantized, 14 MB. On both
 * of the owner's photos it returned the leggings at 2,568 and 2,591 cm², against
 * U²-Netp's 2,643 cm² on the photo where U²-Netp got it right.
 *
 * Everything here is pure apart from `Runner`, so the browser worker and
 * scripts/test-size-grading-photo.ts drive the same code with their own runtime.
 */

import type { ShirtMask } from "./measure";
import { fillHoles } from "./measure";
import { MODEL_INPUT_SIZE, cutSheet, finishMask, maskForMeasuring, modelInput, modelOutputToMask } from "./model-segment";
import { TARGET, frameToSource, insideQuad, worldToFrame, type Quad, type RectFrame } from "./target";

/** The model calls, supplied by whoever has a runtime. */
export type Runner = {
  /** U²-Netp: [1,3,320,320] input → 320×320 salience. */
  salience(input: Float32Array): Promise<Float32Array>;
  /** SlimSAM encoder: [1,3,1024,1024] → an opaque embedding for `samDecode`. */
  samEncode(pixels: Float32Array): Promise<unknown>;
  /** SlimSAM decoder: N single-point prompts → N×3 IoU scores and N×3×256×256 logits. */
  samDecode(embedding: unknown, points: Float32Array, n: number): Promise<{ iou: Float32Array; masks: Float32Array }>;
};

export type FindInput = {
  /** The photo as taken. */
  src: { data: Uint8ClampedArray; width: number; height: number };
  /** The squared-up picture the operator sees, in `frame`'s pixels. */
  picture: Uint8ClampedArray;
  quad: Quad;
  frame: RectFrame;
  /** Stop after the quick model, even if its answer fails the checks — the AI will judge. */
  quickOnly?: boolean;
};

export type FindResult =
  | { mask: ShirtMask; by: "salience" | "segments"; cm2: number; firstTry?: string; rejected?: string }
  | { mask: null; why: string };

export type Stage = "salience" | "segments";

/* ───────────────────────────── the checks ───────────────────────────── */

export const GARMENT_MIN_CM2 = 400;
export const GARMENT_MAX_CM2 = 7000;

/** Pixels of the frame that are photo (not the fill round a tilted shot), at a stride. */
export function photoCoverage(src: { width: number; height: number }, quad: Quad, frame: RectFrame, step: number) {
  const gw = Math.ceil(frame.width / step), gh = Math.ceil(frame.height / step);
  const inPhoto = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      const p = frameToSource(quad, frame, gx * step, gy * step);
      inPhoto[gy * gw + gx] = p.x >= 0 && p.y >= 0 && p.x < src.width - 1 && p.y < src.height - 1 ? 1 : 0;
    }
  }
  return { gw, gh, step, inPhoto };
}

/** Frame pixels in a band round the target's sheet, where the surface shows. */
function ringAround(frame: RectFrame, step: number): Array<[number, number]> {
  const grow = (cm: number): Quad => {
    const W = TARGET.outerWCm, H = TARGET.outerHCm;
    return [[-cm, -cm], [W + cm, -cm], [W + cm, H + cm], [-cm, H + cm]].map(([x, y]) => worldToFrame(frame, x, y)) as Quad;
  };
  const inner = grow(4.5), outer = grow(10);
  const out: Array<[number, number]> = [];
  for (let y = 0; y < frame.height; y += step) {
    for (let x = 0; x < frame.width; x += step) {
      if (insideQuad(outer, x, y) && !insideQuad(inner, x, y)) out.push([x, y]);
    }
  }
  return out;
}

type Shape = {
  /** Sample at frame pixel (x, y). */
  at(x: number, y: number): boolean;
  cm2: number;
  /** Bounding box in frame pixels. */
  box: [number, number, number, number];
};

/**
 * Why a shape is not a garment, or null when it could be one.
 * `ring` and `cover` are precomputed once per photo.
 */
function notAGarment(
  s: Shape,
  ring: Array<[number, number]>,
  cover: ReturnType<typeof photoCoverage>,
): string | null {
  if (s.cm2 < GARMENT_MIN_CM2) return `${Math.round(s.cm2)} cm² is too small for a garment`;
  if (s.cm2 > GARMENT_MAX_CM2) return `${Math.round(s.cm2)} cm² is the size of the table, not a garment`;
  let onRing = 0;
  for (const [x, y] of ring) if (s.at(x, y)) onRing++;
  if (ring.length && onRing / ring.length > 0.5) return "it is the surface the target is lying on";
  // Touching the edge of the photo: the garment is meant to be wholly in frame.
  const { gw, gh, step, inPhoto } = cover;
  let edge = 0, perimeter = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (!inPhoto[gy * gw + gx]) continue;
      const rim =
        gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1 ||
        !inPhoto[gy * gw + gx - 1] || !inPhoto[gy * gw + gx + 1] ||
        !inPhoto[(gy - 1) * gw + gx] || !inPhoto[(gy + 1) * gw + gx];
      if (!rim) continue;
      perimeter++;
      if (s.at(gx * step, gy * step)) edge++;
    }
  }
  if (perimeter && edge / perimeter > 0.04) return "it runs off the edge of the photo";
  return null;
}

function maskShape(m: ShirtMask, pxPerCm: number): Shape {
  let x0 = m.width, y0 = m.height, x1 = 0, y1 = 0;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (!m.data[y * m.width + x]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return {
    at: (x, y) => !!m.data[Math.min(m.height - 1, y) * m.width + Math.min(m.width - 1, x)],
    cm2: m.area / pxPerCm ** 2,
    box: [x0, y0, x1, y1],
  };
}

/** Whether a mask could be a garment, judged in real centimetres. */
export function garmentCheck(
  m: ShirtMask,
  frame: RectFrame,
  src: { width: number; height: number },
  quad: Quad,
): string | null {
  const step = Math.max(2, Math.round(frame.width / 300));
  return notAGarment(maskShape(m, frame.pxPerCm), ringAround(frame, step), photoCoverage(src, quad, frame, step));
}

/* ─────────────────────────────── SlimSAM ─────────────────────────────── */

export const SAM_SIZE = 1024;
const SAM_LOW = 256;
const SAM_MEAN = [0.485, 0.456, 0.406];
const SAM_STD = [0.229, 0.224, 0.225];
/** Prompts per side. 5×5 found the garment on every photo tried; 8×8 cost 2.5× for nothing. */
const SAM_GRID = 5;

/** The picture → SlimSAM's input: longest side 1024, normalised, padded bottom-right. */
export function samInput(rgba: Uint8ClampedArray, width: number, height: number): { pixels: Float32Array; k: number } {
  const k = SAM_SIZE / Math.max(width, height);
  const rw = Math.round(width * k), rh = Math.round(height * k);
  const plane = SAM_SIZE * SAM_SIZE;
  const px = new Float32Array(3 * plane);
  for (let y = 0; y < rh; y++) {
    const fy = Math.min(height - 1, (y + 0.5) / k - 0.5);
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(height - 1, y0 + 1), ay = Math.max(0, fy - y0);
    for (let x = 0; x < rw; x++) {
      const fx = Math.min(width - 1, (x + 0.5) / k - 0.5);
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(width - 1, x0 + 1), ax = Math.max(0, fx - x0);
      for (let c = 0; c < 3; c++) {
        const v =
          rgba[(y0 * width + x0) * 4 + c] * (1 - ax) * (1 - ay) +
          rgba[(y0 * width + x1) * 4 + c] * ax * (1 - ay) +
          rgba[(y1 * width + x0) * 4 + c] * (1 - ax) * ay +
          rgba[(y1 * width + x1) * 4 + c] * ax * ay;
        px[c * plane + y * SAM_SIZE + x] = (v / 255 - SAM_MEAN[c]) / SAM_STD[c];
      }
    }
  }
  return { pixels: px, k };
}

/**
 * Choose the garment among SlimSAM's outlines.
 *
 * Every outline that is not a garment by the checks above goes. Of what is
 * left, an outline whose box holds another candidate it barely touches is the
 * surface round that candidate (the table with a leggings-shaped hole in it).
 * The largest survivor is the garment — the alternatives are parts of it: one
 * leg, the waistband.
 */
export function pickSegment(
  iou: Float32Array,
  logits: Float32Array,
  n: number,
  k: number,
  frame: RectFrame,
  ring: Array<[number, number]>,
  cover: ReturnType<typeof photoCoverage>,
): { index: number; cm2: number } | null {
  const plane = SAM_LOW * SAM_LOW;
  const scale = SAM_LOW / SAM_SIZE; // low-res cells per input pixel
  const cellCm2 = (1 / (k * scale) / frame.pxPerCm) ** 2; // one low-res cell, in cm²
  type Cand = Shape & { index: number; cells: Uint8Array; count: number };
  const cands: Cand[] = [];
  for (let i = 0; i < n * 3; i++) {
    if (iou[i] < 0.8) continue;
    const off = i * plane;
    const cells = new Uint8Array(plane);
    let count = 0, x0 = SAM_LOW, y0 = SAM_LOW, x1 = 0, y1 = 0;
    for (let j = 0; j < plane; j++) {
      if (logits[off + j] <= 0) continue;
      cells[j] = 1;
      count++;
      const x = j % SAM_LOW, y = (j / SAM_LOW) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!count) continue;
    const toFrame = 1 / (k * scale);
    const at = (x: number, y: number) => {
      const cx = Math.floor(x * k * scale), cy = Math.floor(y * k * scale);
      return cx >= 0 && cy >= 0 && cx < SAM_LOW && cy < SAM_LOW && !!cells[cy * SAM_LOW + cx];
    };
    // Holes count as part of the outline for the size check: a shirt with an
    // unselected logo is still a shirt-sized thing.
    let filled = 0;
    for (const v of fillHoles(cells, SAM_LOW, SAM_LOW)) filled += v;
    const shape: Shape = { at, cm2: filled * cellCm2, box: [x0 * toFrame, y0 * toFrame, (x1 + 1) * toFrame, (y1 + 1) * toFrame] };
    if (notAGarment(shape, ring, cover)) continue;
    cands.push({ ...shape, index: i, cells, count });
  }
  const overlap = (a: Cand, b: Cand) => {
    let o = 0;
    for (let j = 0; j < plane; j++) if (a.cells[j] && b.cells[j]) o++;
    return o;
  };
  const surrounds = (a: Cand, b: Cand) => {
    const ix = Math.max(0, Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]));
    const iy = Math.max(0, Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]));
    const bArea = (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]);
    return ix * iy > 0.9 * bArea && overlap(a, b) < 0.1 * b.count;
  };
  const kept = cands.filter((a) => !cands.some((b) => b !== a && b.cm2 > 300 && surrounds(a, b)));
  if (!kept.length) return null;
  kept.sort((a, b) => b.cm2 - a.cm2);
  return { index: kept[0].index, cm2: kept[0].cm2 };
}

/** One of SlimSAM's low-res outlines, upsampled smoothly to the frame. */
export function samMaskToFrame(logits: Float32Array, index: number, k: number, frame: RectFrame): Uint8Array {
  const plane = SAM_LOW * SAM_LOW;
  const off = index * plane;
  const out = new Uint8Array(frame.width * frame.height);
  const s = k * (SAM_LOW / SAM_SIZE);
  for (let y = 0; y < frame.height; y++) {
    const fy = Math.min(SAM_LOW - 1, Math.max(0, (y + 0.5) * s - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(SAM_LOW - 1, y0 + 1), ay = fy - y0;
    for (let x = 0; x < frame.width; x++) {
      const fx = Math.min(SAM_LOW - 1, Math.max(0, (x + 0.5) * s - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(SAM_LOW - 1, x0 + 1), ax = fx - x0;
      const v =
        logits[off + y0 * SAM_LOW + x0] * (1 - ax) * (1 - ay) +
        logits[off + y0 * SAM_LOW + x1] * ax * (1 - ay) +
        logits[off + y1 * SAM_LOW + x0] * (1 - ax) * ay +
        logits[off + y1 * SAM_LOW + x1] * ax * ay;
      out[y * frame.width + x] = v > 0 ? 1 : 0;
    }
  }
  return out;
}

/* ─────────────────────────────── together ─────────────────────────────── */

export async function findGarment(run: Runner, a: FindInput, onStage?: (s: Stage) => void): Promise<FindResult> {
  const { src, picture, quad, frame } = a;
  const out = { width: frame.width, height: frame.height };
  const step = Math.max(2, Math.round(frame.width / 300));
  const ring = ringAround(frame, step);
  const cover = photoCoverage(src, quad, frame, step);

  /* 1. The quick one, on the PHOTO, never the squared-up picture: squaring up
     fills round a tilted shot with white, and on white the whole photo is one
     dark object — the model selected the entire picture. */
  onStage?.("salience");
  const S = MODEL_INPUT_SIZE;
  const probs = await run.salience(modelInput(src.data, src.width, src.height));
  const first = maskForMeasuring(modelOutputToMask(probs.subarray(0, S * S), src.width, src.height), src, out, { quad, frame });
  const firstWhy = notAGarment(maskShape(first, frame.pxPerCm), ring, cover);
  if (!firstWhy || a.quickOnly) {
    return { mask: first, by: "salience", cm2: first.area / frame.pxPerCm ** 2, ...(firstWhy ? { rejected: firstWhy } : {}) };
  }

  // 2. It picked something that is not a garment: outline everything, choose.
  onStage?.("segments");
  const { pixels, k } = samInput(picture, frame.width, frame.height);
  const embedding = await run.samEncode(pixels);
  const pts: number[] = [];
  for (let j = 0; j < SAM_GRID; j++) {
    for (let i = 0; i < SAM_GRID; i++) {
      const fx = ((i + 0.5) / SAM_GRID) * frame.width, fy = ((j + 0.5) / SAM_GRID) * frame.height;
      const gx = Math.min(cover.gw - 1, Math.round(fx / step)), gy = Math.min(cover.gh - 1, Math.round(fy / step));
      if (!cover.inPhoto[gy * cover.gw + gx]) continue; // a prompt on the fill finds the fill
      pts.push(fx * k, fy * k);
    }
  }
  const n = pts.length / 2;
  const { iou, masks } = await run.samDecode(embedding, new Float32Array(pts), n);
  const pick = pickSegment(iou, masks, n, k, frame, ring, cover);
  if (!pick) return { mask: null, why: `the quick look found something that is not a garment (${firstWhy}), and the closer look found nothing garment-sized` };
  const raw = samMaskToFrame(masks, pick.index, k, frame);
  cutSheet(raw, frame.width, frame.height, frame);
  const mask = finishMask(raw, frame.width, frame.height);
  return { mask, by: "segments", cm2: mask.area / frame.pxPerCm ** 2, firstTry: firstWhy };
}
