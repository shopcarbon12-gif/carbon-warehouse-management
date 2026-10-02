/**
 * What is this garment, and where are its points of measure?
 *
 * The segmentation in measure.ts already produces a clean silhouette. That
 * silhouette says more than enough to tell the four families apart without
 * sending the photo anywhere: a pair of trousers has a gap between the legs, a
 * top has sleeves standing out from the body, a skirt is widest at the hem and
 * narrow where it starts. So the type is read from the shape, on the device,
 * and the operator can override it when a cut is unusual.
 *
 * Everything here is pure functions over the mask — no DOM, no canvas — so the
 * same code runs in the browser and in node test scripts.
 *
 * The one rule that matters for correctness: these are FLAT measurements, taken
 * across the garment as it lies. Nothing here doubles a width into a body
 * circumference. A 52 cm chest means 52 cm across, which is what a tape on the
 * table reads, and what Carbon's own size guides publish.
 */

import { centerRun, rowExtent, type Segment, type ShirtMask } from "./measure";

export type GarmentType = "top" | "trousers" | "shorts" | "dress" | "skirt";

export const GARMENT_LABELS: Record<GarmentType, string> = {
  top: "Top / T-shirt",
  trousers: "Trousers / leggings",
  shorts: "Shorts",
  dress: "Dress",
  skirt: "Skirt",
};

/** Every point of measure this module can produce, across all garment types. */
export const ALL_POMS = [
  "chest", "waist", "hip", "length", "hem", "shoulder", "sleeve",
  "inseam", "outseam", "legOpening", "rise",
] as const;
export type PomKey = (typeof ALL_POMS)[number];

export const POM_LABEL: Record<PomKey, string> = {
  chest: "Chest width (flat)",
  waist: "Waist width (flat)",
  hip: "Hip width (flat)",
  length: "Body length",
  hem: "Hem width (flat)",
  shoulder: "Shoulder width",
  sleeve: "Sleeve length",
  inseam: "Inseam",
  outseam: "Outseam",
  legOpening: "Leg opening (flat)",
  rise: "Front rise",
};

/** Which points each family is measured on, in the order they are shown. */
export const POMS_FOR: Record<GarmentType, PomKey[]> = {
  top: ["chest", "length", "hem", "shoulder", "sleeve"],
  trousers: ["waist", "hip", "inseam", "outseam", "legOpening", "rise"],
  shorts: ["waist", "hip", "inseam", "legOpening"],
  dress: ["chest", "waist", "length", "hem"],
  skirt: ["waist", "hip", "length", "hem"],
};

export type Classification = {
  type: GarmentType;
  /** 0–1. Below ~0.6 the UI asks the operator to confirm. */
  confidence: number;
  /** Plain-English reason, shown so a wrong guess is obvious rather than silent. */
  why: string;
};

export type GarmentMeasurement = {
  /** Centimetres. */
  cm: number;
  /** Where it was taken, for the overlay. */
  line: Segment;
};

export type GarmentResult =
  | { ok: true; type: GarmentType; classification: Classification; points: Partial<Record<PomKey, GarmentMeasurement>> }
  | { ok: false; error: string; classification?: Classification };

/* ─────────────────────────────── shape reading ───────────────────────────── */

type Shape = {
  mask: ShirtMask;
  top: number;
  bottom: number;
  left: number;
  right: number;
  h: number;
  w: number;
  /** Width of the silhouette at each row, 0 where empty. */
  widths: Int32Array;
  /** Number of separate runs on each row — 2+ in the lower body means legs. */
  runs: Int32Array;
  /** Horizontal centre of the garment, from the lower body. */
  cx: number;
};

function rowRuns(data: Uint8Array, w: number, y: number): Array<[number, number]> {
  const row = y * w;
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let x = 0; x < w; x++) {
    if (data[row + x]) {
      if (start < 0) start = x;
    } else if (start >= 0) {
      out.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0) out.push([start, w - 1]);
  return out;
}

/** Runs wide enough to be part of the garment, not speckle the clean-up missed. */
function solidRuns(data: Uint8Array, w: number, y: number, minRun: number): Array<[number, number]> {
  return rowRuns(data, w, y).filter((r) => r[1] - r[0] + 1 >= minRun);
}

export function readShape(mask: ShirtMask): Shape | null {
  const { data, width, height } = mask;
  let top = -1, bottom = -1, left = width, right = -1;
  const widths = new Int32Array(height);
  const runs = new Int32Array(height);
  const minRun = Math.max(2, Math.round(width * 0.012));
  for (let y = 0; y < height; y++) {
    const ext = rowExtent(data, width, y);
    if (!ext) continue;
    if (top < 0) top = y;
    bottom = y;
    if (ext[0] < left) left = ext[0];
    if (ext[1] > right) right = ext[1];
    const rs = solidRuns(data, width, y, minRun);
    widths[y] = rs.reduce((a, r) => a + (r[1] - r[0] + 1), 0);
    runs[y] = rs.length;
  }
  if (top < 0 || bottom <= top) return null;

  // Centre from the lower body, where sleeves cannot pull it sideways.
  let sum = 0, n = 0;
  for (let y = bottom - Math.round((bottom - top) * 0.25); y <= bottom; y++) {
    const ext = rowExtent(data, width, y);
    if (ext) { sum += (ext[0] + ext[1]) / 2; n++; }
  }
  return {
    mask, top, bottom, left, right,
    h: bottom - top + 1,
    w: right - left + 1,
    widths, runs,
    cx: n ? Math.round(sum / n) : Math.round((left + right) / 2),
  };
}

/* ────────────────────────────── classification ───────────────────────────── */

/**
 * Where the legs separate, or -1.
 *
 * A row counts only when it has two solid runs with a real gap between them,
 * and the split has to persist down the garment — one row with a crease that
 * reads as background is not a pair of legs.
 */
function crotchY(s: Shape): number {
  const { data, width } = s.mask;
  const minRun = Math.max(2, Math.round(width * 0.012));
  const minGap = Math.max(3, Math.round(s.w * 0.04));
  const need = Math.max(4, Math.round(s.h * 0.08)); // rows the split must hold for
  for (let y = s.top + Math.round(s.h * 0.25); y <= s.bottom - need; y++) {
    const rs = solidRuns(data, width, y, minRun);
    if (rs.length < 2) continue;
    if (rs[1][0] - rs[0][1] - 1 < minGap) continue;
    let held = 0;
    for (let k = 1; k <= need; k++) {
      const r2 = solidRuns(data, width, y + k, minRun);
      if (r2.length >= 2 && r2[1][0] - r2[0][1] - 1 >= minGap * 0.6) held++;
    }
    if (held >= need * 0.7) return y;
  }
  return -1;
}

/** Row where the sleeves stop and the body begins, scanning up from the hem. */
function armpitY(s: Shape): number {
  const { data, width } = s.mask;
  const recent: number[] = [];
  for (let y = s.bottom - Math.round(s.h * 0.05); y >= s.top + Math.round(s.h * 0.1); y--) {
    const run = centerRun(data, width, y, s.cx);
    if (!run) continue;
    const w = run[1] - run[0] + 1;
    if (recent.length >= 5) {
      const sorted = [...recent].sort((a, b) => a - b);
      const bodyW = sorted[sorted.length >> 1];
      if (w > bodyW * 1.2) {
        let wide = 0;
        for (let k = 1; k <= 3; k++) {
          const r2 = centerRun(data, width, y - k, s.cx);
          if (r2 && r2[1] - r2[0] + 1 > bodyW * 1.2) wide++;
        }
        if (wide >= 2) return y + 1;
      }
    }
    recent.push(w);
    if (recent.length > 15) recent.shift();
  }
  return -1;
}

export function classify(mask: ShirtMask): Classification | null {
  const s = readShape(mask);
  if (!s) return null;

  const crotch = crotchY(s);
  const pit = armpitY(s);
  const aspect = s.h / Math.max(1, s.w);

  // Width of the very top of the garment, relative to its widest point: a
  // waistband starts narrow, shoulders do not.
  const topBand = Math.max(1, Math.round(s.h * 0.06));
  let topW = 0;
  for (let y = s.top; y < s.top + topBand; y++) topW = Math.max(topW, s.widths[y]);
  let maxW = 0;
  for (let y = s.top; y <= s.bottom; y++) maxW = Math.max(maxW, s.widths[y]);
  const topRatio = topW / Math.max(1, maxW);

  // Hem vs the narrowest point above it — a skirt or a dress flares.
  const hemW = s.widths[s.bottom - Math.max(1, Math.round(s.h * 0.03))] || s.widths[s.bottom];
  let waistW = Infinity;
  for (let y = s.top + Math.round(s.h * 0.2); y <= s.top + Math.round(s.h * 0.6); y++) {
    if (s.widths[y] > 0) waistW = Math.min(waistW, s.widths[y]);
  }
  const flare = hemW / Math.max(1, waistW === Infinity ? hemW : waistW);

  if (crotch > 0) {
    // Legs. Long = trousers, short = shorts. The split point relative to the
    // whole garment separates them more reliably than height alone, because a
    // photo's framing varies but the proportion does not.
    const legFraction = (s.bottom - crotch) / s.h;
    const isShort = aspect < 1.15 || legFraction < 0.45;
    return {
      type: isShort ? "shorts" : "trousers",
      confidence: 0.9,
      why: `legs separate ${Math.round(legFraction * 100)}% up from the hem`,
    };
  }

  if (pit > 0) {
    // Sleeves. Long enough and it is a dress rather than a top.
    const isDress = aspect > 1.55;
    return {
      type: isDress ? "dress" : "top",
      confidence: isDress ? 0.7 : 0.85,
      why: isDress
        ? `sleeves found, and it is ${aspect.toFixed(1)}× taller than wide`
        : "sleeves stand out from the body",
    };
  }

  // No legs, no sleeves. A narrow top edge that flares to the hem is a skirt;
  // otherwise a sleeveless dress is the better guess.
  if (topRatio < 0.72 && flare > 1.12) {
    return {
      type: aspect > 1.5 ? "dress" : "skirt",
      confidence: 0.6,
      why: `narrow at the top, ${flare.toFixed(2)}× wider at the hem`,
    };
  }
  return {
    type: aspect > 1.4 ? "dress" : "top",
    confidence: 0.45,
    why: "no sleeves or leg split found — please confirm the type",
  };
}

/* ─────────────────────────────── measurement ─────────────────────────────── */

const seg = (x1: number, y1: number, x2: number, y2: number): Segment => ({
  a: { x: x1, y: y1 },
  b: { x: x2, y: y2 },
});

/** Median run through the body centre over a few rows — one ragged row cannot move it. */
function steadyRun(s: Shape, y: number, span = 2): { w: number; run: [number, number] } | null {
  const out: { w: number; run: [number, number] }[] = [];
  for (let yy = y - span; yy <= y + span; yy++) {
    if (yy < s.top || yy > s.bottom) continue;
    const run = centerRun(s.mask.data, s.mask.width, yy, s.cx);
    if (run) out.push({ w: run[1] - run[0] + 1, run });
  }
  if (!out.length) return null;
  out.sort((a, b) => a.w - b.w);
  return out[out.length >> 1];
}

/** Full extent of the row, sleeves included. */
function steadyExtent(s: Shape, y: number, span = 2): { w: number; run: [number, number] } | null {
  const out: { w: number; run: [number, number] }[] = [];
  for (let yy = y - span; yy <= y + span; yy++) {
    if (yy < s.top || yy > s.bottom) continue;
    const ext = rowExtent(s.mask.data, s.mask.width, yy);
    if (ext) out.push({ w: ext[1] - ext[0] + 1, run: ext });
  }
  if (!out.length) return null;
  out.sort((a, b) => a.w - b.w);
  return out[out.length >> 1];
}

export function measureGarment(
  mask: ShirtMask,
  pxPerCm: number,
  forced?: GarmentType,
): GarmentResult {
  const s = readShape(mask);
  if (!s) return { ok: false, error: "Nothing was found in the photo." };
  const auto = classify(mask);
  const type = forced ?? auto?.type ?? "top";
  const classification = auto ?? { type, confidence: 0, why: "could not read the shape" };

  const cm = (px: number) => px / pxPerCm;
  const points: Partial<Record<PomKey, GarmentMeasurement>> = {};
  const put = (k: PomKey, px: number, line: Segment) => {
    points[k] = { cm: cm(px), line };
  };

  // Body length / outseam: top edge to bottom edge, down the centre.
  const lengthPx = s.h;
  const lengthLine = seg(s.cx, s.top, s.cx, s.bottom);

  if (type === "trousers" || type === "shorts") {
    const crotch = crotchY(s);
    const waistY = s.top + Math.max(1, Math.round(s.h * 0.02));
    const waist = steadyExtent(s, waistY, 2);
    if (!waist) return { ok: false, error: "Could not read the waistband.", classification };
    put("waist", waist.w, seg(waist.run[0], waistY, waist.run[1], waistY));

    // Hip: the widest row between the waistband and the crotch.
    const hipTop = s.top + Math.round(s.h * 0.05);
    const hipBottom = crotch > 0 ? crotch : s.top + Math.round(s.h * 0.45);
    let hipY = hipTop, hipW = -1;
    for (let y = hipTop; y <= hipBottom; y++) {
      if (s.runs[y] === 1 && s.widths[y] > hipW) { hipW = s.widths[y]; hipY = y; }
    }
    const hip = steadyExtent(s, hipY, 2);
    if (hip) put("hip", hip.w, seg(hip.run[0], hipY, hip.run[1], hipY));

    if (crotch > 0) {
      put("inseam", s.bottom - crotch, seg(s.cx, crotch, s.cx, s.bottom));
      put("rise", crotch - s.top, seg(s.left + Math.round(s.w * 0.12), s.top, s.left + Math.round(s.w * 0.12), crotch));
      // Leg opening: one leg's width just above the hem.
      const legY = s.bottom - Math.max(2, Math.round(s.h * 0.02));
      const rs = solidRuns(s.mask.data, s.mask.width, legY, Math.max(2, Math.round(s.mask.width * 0.012)));
      if (rs.length >= 1) {
        const leg = rs[0];
        put("legOpening", leg[1] - leg[0] + 1, seg(leg[0], legY, leg[1], legY));
      }
    } else if (type === "shorts") {
      return { ok: false, error: "Could not find where the legs separate — lay the shorts flat with a gap between the legs.", classification };
    }
    if (type === "trousers") put("outseam", lengthPx, lengthLine);
    return { ok: true, type, classification, points };
  }

  if (type === "skirt") {
    const waistY = s.top + Math.max(1, Math.round(s.h * 0.02));
    const waist = steadyExtent(s, waistY, 2);
    if (!waist) return { ok: false, error: "Could not read the waistband.", classification };
    put("waist", waist.w, seg(waist.run[0], waistY, waist.run[1], waistY));
    let hipY = s.top, hipW = -1;
    for (let y = s.top + Math.round(s.h * 0.1); y <= s.top + Math.round(s.h * 0.5); y++) {
      if (s.widths[y] > hipW) { hipW = s.widths[y]; hipY = y; }
    }
    const hip = steadyExtent(s, hipY, 2);
    if (hip) put("hip", hip.w, seg(hip.run[0], hipY, hip.run[1], hipY));
    const hemY = s.bottom - Math.max(2, Math.round(s.h * 0.02));
    const hem = steadyExtent(s, hemY, 2);
    if (hem) put("hem", hem.w, seg(hem.run[0], hemY, hem.run[1], hemY));
    put("length", lengthPx, lengthLine);
    return { ok: true, type, classification, points };
  }

  // top | dress — both measured across the chest, below the armpit when there is one.
  const pit = armpitY(s);
  const hemY = s.bottom - Math.max(2, Math.round(s.h * 0.02));
  const hem = steadyRun(s, hemY, 2);
  if (hem) put("hem", hem.w, seg(hem.run[0], hemY, hem.run[1], hemY));
  put("length", lengthPx, lengthLine);

  if (pit > 0) {
    const chestY = Math.min(s.bottom, pit + Math.max(1, Math.round(2.54 * pxPerCm)));
    const chest = steadyRun(s, chestY, 1);
    if (!chest) return { ok: false, error: "Could not read the chest.", classification };
    put("chest", chest.w, seg(chest.run[0], chestY, chest.run[1], chestY));

    if (type === "top") {
      // Shoulder: the full extent a little above the armpit, where the sleeve
      // head sits. Measured across the outside of both shoulder seams.
      const shoulderY = Math.max(s.top + 1, pit - Math.round(s.h * 0.06));
      const sh = steadyExtent(s, shoulderY, 2);
      if (sh) put("shoulder", sh.w, seg(sh.run[0], shoulderY, sh.run[1], shoulderY));
      // Sleeve: shoulder point out to the widest row's edge, which is the cuff.
      let wideY = s.top, wideW = -1;
      for (let y = s.top; y <= (pit > 0 ? pit : s.bottom); y++) {
        if (s.widths[y] > wideW) { wideW = s.widths[y]; wideY = y; }
      }
      const widest = rowExtent(s.mask.data, s.mask.width, wideY);
      if (sh && widest) {
        const dx = sh.run[0] - widest[0];
        const dy = wideY - shoulderY;
        put("sleeve", Math.hypot(dx, dy), seg(sh.run[0], shoulderY, widest[0], wideY));
      }
    }
  } else {
    // Sleeveless: take the chest at the widest row in the upper half instead.
    let cy = s.top, cw = -1;
    for (let y = s.top; y <= s.top + Math.round(s.h * 0.5); y++) {
      if (s.widths[y] > cw) { cw = s.widths[y]; cy = y; }
    }
    const chest = steadyExtent(s, cy, 2);
    if (chest) put("chest", chest.w, seg(chest.run[0], cy, chest.run[1], cy));
  }

  if (type === "dress") {
    // Waist: the narrowest row between chest and hem.
    let wy = -1, ww = Infinity;
    for (let y = s.top + Math.round(s.h * 0.25); y <= s.top + Math.round(s.h * 0.65); y++) {
      if (s.widths[y] > 0 && s.runs[y] === 1 && s.widths[y] < ww) { ww = s.widths[y]; wy = y; }
    }
    if (wy > 0) {
      const waist = steadyExtent(s, wy, 2);
      if (waist) put("waist", waist.w, seg(waist.run[0], wy, waist.run[1], wy));
    }
  }

  return { ok: true, type, classification, points };
}
