/**
 * What is this garment, and where are its points of measure?
 *
 * The segmentation in measure.ts already produces a clean silhouette. That
 * silhouette says more than enough to tell the families apart without sending
 * the photo anywhere: a pair of trousers has a gap between the legs, a top has
 * sleeves standing out from the body, a skirt is widest at the hem and narrow
 * where it starts, and a romper has both sleeves and legs. So the type is read
 * from the shape, on the device, and the operator can override it when a cut is
 * unusual.
 *
 * Where the catalogue already knows what a product is, that beats reading the
 * shape — see catalog-family.ts. The silhouette is the fallback, not the first
 * answer.
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

export type GarmentType = "top" | "trousers" | "shorts" | "dress" | "skirt" | "onepiece";

export const GARMENT_LABELS: Record<GarmentType, string> = {
  top: "Top / T-shirt",
  trousers: "Trousers / leggings",
  shorts: "Shorts",
  dress: "Dress",
  skirt: "Skirt",
  onepiece: "Bodysuit / romper / overall",
};

/** Every point of measure this module knows about, across all garment types. */
export const ALL_POMS = [
  // Read off the silhouette.
  "chest", "waist", "hip", "length", "hem", "shoulder", "sleeve",
  "sleeveInseam", "bicep", "cuff", "armhole",
  "inseam", "outseam", "legOpening", "rise", "thigh", "knee", "calf",
  // Typed in — see POM_SOURCE.
  "neck", "neckDrop", "collarHeight", "shoulderSlope", "waistbandHeight",
  "frontPocketOpening", "backPocketWidth", "backPocketLength",
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
  sleeveInseam: "Sleeve length (underarm)",
  bicep: "Sleeve width (bicep)",
  cuff: "Sleeve opening (flat)",
  armhole: "Armhole depth",
  inseam: "Inseam",
  outseam: "Outseam",
  legOpening: "Leg opening (flat)",
  rise: "Front rise",
  thigh: "Thigh width (flat)",
  knee: "Knee width (flat)",
  calf: "Calf width (flat)",
  neck: "Neck opening (seam to seam)",
  neckDrop: "Front neck drop",
  collarHeight: "Collar height",
  shoulderSlope: "Shoulder slope",
  waistbandHeight: "Waistband height",
  frontPocketOpening: "Front pocket opening",
  backPocketWidth: "Back pocket width",
  backPocketLength: "Back pocket length",
};

/**
 * Where each number comes from.
 *
 * "camera" means the silhouette gives it. "manual" means it does not, and
 * saying otherwise would be the dishonest kind of feature: a neckline is not a
 * notch in the outline of a flat-laid garment — the back panel shows through
 * the hole, so the top edge runs straight across — and a 0.7 cm collar height
 * is below anything a photo of a whole garment can resolve. Those are offered
 * as boxes to type into on the item card, which is how a tech pack gets filled
 * in anyway, rather than as numbers the app pretends to have measured.
 */
export type PomSource = "camera" | "manual";
export const POM_SOURCE: Record<PomKey, PomSource> = {
  chest: "camera", waist: "camera", hip: "camera", length: "camera", hem: "camera",
  shoulder: "camera", sleeve: "camera", sleeveInseam: "camera", bicep: "camera",
  cuff: "camera", armhole: "camera", inseam: "camera", outseam: "camera",
  legOpening: "camera", rise: "camera", thigh: "camera", knee: "camera", calf: "camera",
  neck: "manual", neckDrop: "manual", collarHeight: "manual", shoulderSlope: "manual",
  waistbandHeight: "manual", frontPocketOpening: "manual", backPocketWidth: "manual",
  backPocketLength: "manual",
};

/**
 * The label for a point, which depends on which side was photographed.
 *
 * A tech pack lists front rise and back rise as two numbers; here they are the
 * same point measured on two sides, so the side decides what it is called. Using
 * one key for both is what keeps a back reading from overwriting a front one.
 */
export function pomLabel(key: string, view: "front" | "back" = "front"): string {
  if (view === "back") {
    if (key === "rise") return "Back rise";
    if (key === "neckDrop") return "Back neck drop";
    if (key === "length") return "Back length";
  }
  return POM_LABEL[key as PomKey] ?? key;
}

/** Which points each family is measured on, in the order they are shown. */
export const POMS_FOR: Record<GarmentType, PomKey[]> = {
  top: [
    "chest", "waist", "hem", "length", "shoulder", "armhole",
    "sleeve", "sleeveInseam", "bicep", "cuff",
    "neck", "neckDrop", "collarHeight", "shoulderSlope",
  ],
  trousers: [
    "waist", "hip", "thigh", "knee", "calf", "legOpening",
    "inseam", "outseam", "rise",
    "waistbandHeight", "frontPocketOpening", "backPocketWidth", "backPocketLength",
  ],
  shorts: [
    "waist", "hip", "thigh", "legOpening", "inseam", "outseam", "rise",
    "waistbandHeight", "frontPocketOpening", "backPocketWidth", "backPocketLength",
  ],
  dress: [
    "chest", "waist", "hip", "hem", "length", "shoulder", "armhole",
    "sleeve", "sleeveInseam", "bicep", "cuff", "neck", "neckDrop",
  ],
  skirt: ["waist", "hip", "hem", "length", "waistbandHeight"],
  /* A one-piece is measured on both halves. Reporting only the legs — which is
     what happens when a romper is taken for a pair of shorts — throws away the
     entire upper body and nothing on screen says so. */
  onepiece: [
    "chest", "waist", "hip", "length", "shoulder", "armhole", "sleeve", "bicep", "cuff",
    "inseam", "thigh", "legOpening", "rise", "neck", "neckDrop",
  ],
};

/* Points that exist on only one side. A front pocket is not on the back of a
   pair of jeans, and offering it there — which is what happened — asks the
   operator to measure something they cannot see. */
const FRONT_ONLY: ReadonlySet<string> = new Set(["frontPocketOpening"]);
const BACK_ONLY: ReadonlySet<string> = new Set(["backPocketWidth", "backPocketLength"]);

/**
 * The points for one side of one garment, in guide order.
 *
 * The order is a contract with the pictures in public/size-grading/guide/: the
 * Nth point here is the circle numbered N on that garment's picture for that
 * side. Change this order and the guide stops matching the screen, so change the
 * pictures with it.
 */
export function pomsFor(type: GarmentType, view: "front" | "back"): PomKey[] {
  return POMS_FOR[type].filter((k) => (view === "front" ? !BACK_ONLY.has(k) : !FRONT_ONLY.has(k)));
}

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

/**
 * Where the body widens into sleeves, scanning up from `startBelow`.
 *
 * `startBelow` matters on anything with legs. `centerRun` does not give up when
 * the centre column falls in the gap between two legs — it snaps to the nearest
 * run — so a scan that starts at the hem reads ONE LEG as the body, and the
 * step up from leg width to hip width looks exactly like a body widening into
 * sleeves. On a romper that returned the crotch as the armpit. Callers that
 * know where the legs separate pass a point above it.
 */
function armpitY(s: Shape, startBelow?: number): number {
  const { data, width } = s.mask;
  const recent: number[] = [];
  const from = Math.min(startBelow ?? s.bottom, s.bottom) - Math.round(s.h * 0.05);
  for (let y = from; y >= s.top + Math.round(s.h * 0.1); y--) {
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
  // Above the legs when there are legs — see armpitY.
  const pit = armpitY(s, crotch > 0 ? crotch : undefined);
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

  /* Sleeves AND a leg split: a romper, an overall, a jumpsuit. This has to be
     tested before the leg branch, because a one-piece does have legs and would
     otherwise be filed as shorts — which measures the bottom half and silently
     discards the top. The catalogue has forty of these (bodysuits, swimsuits,
     rompers, overalls), so it is not an edge case. */
  if (crotch > 0 && pit > 0 && pit < crotch) {
    return {
      type: "onepiece",
      confidence: 0.8,
      why: "sleeves at the top and legs at the bottom — one piece",
    };
  }

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
/** Top and bottom of the silhouette in one column — a sleeve's width, lying flat. */
function colExtent(s: Shape, x: number): [number, number] | null {
  const { data, width } = s.mask;
  if (x < 0 || x >= width) return null;
  let lo = -1;
  let hi = -1;
  for (let y = s.top; y <= s.bottom; y++) {
    if (!data[y * width + x]) continue;
    if (lo < 0) lo = y;
    hi = y;
  }
  return lo < 0 ? null : [lo, hi];
}

/** The steadiest column extent around x, so one frayed thread cannot set it. */
function steadyCol(s: Shape, x: number, span = 2): { w: number; run: [number, number] } | null {
  const cands: Array<{ w: number; run: [number, number] }> = [];
  for (let d = -span; d <= span; d++) {
    const e = colExtent(s, x + d);
    if (e) cands.push({ w: e[1] - e[0] + 1, run: e });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.w - b.w);
  return cands[cands.length >> 1];
}

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

  if (type === "onepiece") {
    /* Both halves, in one pass: the chest and sleeves off the top of the
       silhouette, the hip and legs off the bottom, and the waist at the
       narrowest point in between. */
    const crotch = crotchY(s);
    const pit = armpitY(s, crotch > 0 ? crotch : undefined);
    put("length", lengthPx, lengthLine);

    if (pit > 0) {
      const chestY = Math.min(s.bottom, pit + Math.max(1, Math.round(2.54 * pxPerCm)));
      const chest = steadyRun(s, chestY, 1);
      if (chest) put("chest", chest.w, seg(chest.run[0], chestY, chest.run[1], chestY));

      const shoulderY = Math.max(s.top + 1, pit - Math.round(s.h * 0.06));
      const sh = steadyExtent(s, shoulderY, 2);
      if (sh) put("shoulder", sh.w, seg(sh.run[0], shoulderY, sh.run[1], shoulderY));

      let wideY = s.top, wideW = -1;
      for (let y = s.top; y <= pit; y++) {
        if (s.widths[y] > wideW) { wideW = s.widths[y]; wideY = y; }
      }
      const widest = rowExtent(s.mask.data, s.mask.width, wideY);
      if (sh && widest) {
        put("sleeve", Math.hypot(sh.run[0] - widest[0], wideY - shoulderY),
            seg(sh.run[0], shoulderY, widest[0], wideY));
      }
      // The same sleeve detail a top gets — a romper has sleeves like anything else.
      const chestRun = steadyRun(s, Math.min(s.bottom, pit + Math.max(1, Math.round(2.54 * pxPerCm))), 1);
      if (chestRun) {
        const bodyLeft = chestRun.run[0];
        const bicepX = Math.round(bodyLeft - Math.max(2, 1 * pxPerCm));
        const bicep = steadyCol(s, bicepX, 2);
        if (bicep && bicepX > s.left) put("bicep", bicep.w, seg(bicepX, bicep.run[0], bicepX, bicep.run[1]));
        const cuffX = Math.round(s.left + Math.max(2, 0.7 * pxPerCm));
        const cuff = steadyCol(s, cuffX, 2);
        if (cuff && cuffX < bodyLeft) put("cuff", cuff.w, seg(cuffX, cuff.run[0], cuffX, cuff.run[1]));
        if (sh) {
          put("armhole", Math.hypot(bodyLeft - sh.run[0], pit - shoulderY),
              seg(sh.run[0], shoulderY, bodyLeft, pit));
        }
      }
    } else {
      // Sleeveless (a bodysuit, a one-piece swimsuit): take the chest at the
      // widest row in the upper third instead of below an armpit that is not there.
      let cy = s.top, cw = -1;
      for (let y = s.top; y <= s.top + Math.round(s.h * 0.35); y++) {
        if (s.widths[y] > cw) { cw = s.widths[y]; cy = y; }
      }
      const chest = steadyExtent(s, cy, 2);
      if (chest) put("chest", chest.w, seg(chest.run[0], cy, chest.run[1], cy));
    }

    // Waist: the narrowest single run between the armpit and the crotch.
    const waistFrom = (pit > 0 ? pit : s.top + Math.round(s.h * 0.2)) + 1;
    const waistTo = crotch > 0 ? crotch - 1 : s.top + Math.round(s.h * 0.65);
    let wy = -1, ww = Infinity;
    for (let y = waistFrom; y <= waistTo; y++) {
      if (s.widths[y] > 0 && s.runs[y] === 1 && s.widths[y] < ww) { ww = s.widths[y]; wy = y; }
    }
    if (wy > 0) {
      const waist = steadyExtent(s, wy, 2);
      if (waist) put("waist", waist.w, seg(waist.run[0], wy, waist.run[1], wy));
    }

    // Hip: the widest single run between the waist and the crotch.
    const hipTo = crotch > 0 ? crotch : s.top + Math.round(s.h * 0.75);
    let hy = -1, hw = -1;
    for (let y = wy > 0 ? wy : waistFrom; y <= hipTo; y++) {
      if (s.runs[y] === 1 && s.widths[y] > hw) { hw = s.widths[y]; hy = y; }
    }
    if (hy > 0) {
      const hip = steadyExtent(s, hy, 2);
      if (hip) put("hip", hip.w, seg(hip.run[0], hy, hip.run[1], hy));
    }

    if (crotch > 0) {
      put("inseam", s.bottom - crotch, seg(s.cx, crotch, s.cx, s.bottom));
      put("rise", crotch - s.top, seg(s.left + Math.round(s.w * 0.12), s.top, s.left + Math.round(s.w * 0.12), crotch));
      const legMin = Math.max(2, Math.round(s.mask.width * 0.012));
      const legAt = (frac: number) => {
        const y = Math.round(crotch + (s.bottom - crotch) * frac);
        const rs = solidRuns(s.mask.data, s.mask.width, y, legMin);
        return rs.length >= 1 ? { y, run: rs[0] } : null;
      };
      const thigh = legAt(0.06);
      if (thigh) put("thigh", thigh.run[1] - thigh.run[0] + 1, seg(thigh.run[0], thigh.y, thigh.run[1], thigh.y));
      const opening = legAt(0.98);
      if (opening) {
        put("legOpening", opening.run[1] - opening.run[0] + 1,
            seg(opening.run[0], opening.y, opening.run[1], opening.y));
      }
    }
    return { ok: true, type, classification, points };
  }

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

      /* Everything down one leg. The left leg is taken throughout — it is the
         first solid run on the row, and a tech pack measures one leg, not the
         pair. Each point is a fraction of the way from the crotch to the hem,
         so the same number means the same place on a 30 inch and a 34 inch
         inseam instead of drifting with the length. */
      const legMin = Math.max(2, Math.round(s.mask.width * 0.012));
      const legAt = (frac: number) => {
        const y = Math.round(crotch + (s.bottom - crotch) * frac);
        const rs = solidRuns(s.mask.data, s.mask.width, y, legMin);
        return rs.length >= 1 ? { y, run: rs[0] } : null;
      };

      // Thigh: just below the crotch, before the leg starts to taper.
      const thigh = legAt(0.06);
      if (thigh) {
        put("thigh", thigh.run[1] - thigh.run[0] + 1,
            seg(thigh.run[0], thigh.y, thigh.run[1], thigh.y));
      }
      // Knee and calf only mean something on a full-length leg.
      if (type === "trousers") {
        const knee = legAt(0.45);
        if (knee) put("knee", knee.run[1] - knee.run[0] + 1, seg(knee.run[0], knee.y, knee.run[1], knee.y));
        const calf = legAt(0.68);
        if (calf) put("calf", calf.run[1] - calf.run[0] + 1, seg(calf.run[0], calf.y, calf.run[1], calf.y));
      }
      // Leg opening: one leg's width just above the hem.
      const opening = legAt(0.98);
      if (opening) {
        put("legOpening", opening.run[1] - opening.run[0] + 1,
            seg(opening.run[0], opening.y, opening.run[1], opening.y));
      }
    } else if (type === "shorts") {
      return { ok: false, error: "Could not find where the legs separate — lay the shorts flat with a gap between the legs.", classification };
    }
    // Outseam / side length — on both, since the swim spec asks for it on shorts.
    put("outseam", lengthPx, lengthLine);
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

    // Shoulder: the full extent a little above the armpit, where the sleeve
    // head sits. Measured across the outside of both shoulder seams.
    const shoulderY = Math.max(s.top + 1, pit - Math.round(s.h * 0.06));
    const sh = steadyExtent(s, shoulderY, 2);
    if (sh) put("shoulder", sh.w, seg(sh.run[0], shoulderY, sh.run[1], shoulderY));

    // Sleeve: shoulder point out to the widest row's edge, which is the cuff.
    let wideY = s.top, wideW = -1;
    for (let y = s.top; y <= pit; y++) {
      if (s.widths[y] > wideW) { wideW = s.widths[y]; wideY = y; }
    }
    const widest = rowExtent(s.mask.data, s.mask.width, wideY);
    if (sh && widest) {
      put("sleeve", Math.hypot(sh.run[0] - widest[0], wideY - shoulderY),
          seg(sh.run[0], shoulderY, widest[0], wideY));
    }

    /* Sleeve detail, all taken on the LEFT sleeve as it lies.
     *
     * A flat sleeve is a horizontal band, so its width is a column's extent
     * rather than a row's — measuring it across the row would give the body. */
    if (chest) {
      const bodyLeft = chest.run[0];
      // Bicep: the sleeve a centimetre out from where it leaves the body,
      // which is where a tech pack takes it.
      const bicepX = Math.round(bodyLeft - Math.max(2, 1 * pxPerCm));
      const bicep = steadyCol(s, bicepX, 2);
      if (bicep && bicepX > s.left) {
        put("bicep", bicep.w, seg(bicepX, bicep.run[0], bicepX, bicep.run[1]));
      }
      // Cuff: the sleeve opening, taken just inside the outermost point so the
      // measurement is across fabric and not across a single frayed corner.
      const cuffX = Math.round(s.left + Math.max(2, 0.7 * pxPerCm));
      const cuff = steadyCol(s, cuffX, 2);
      if (cuff && cuffX < bodyLeft) {
        put("cuff", cuff.w, seg(cuffX, cuff.run[0], cuffX, cuff.run[1]));
      }
      // Armhole depth: shoulder point down to the armpit, straight.
      if (sh) {
        put("armhole", Math.hypot(bodyLeft - sh.run[0], pit - shoulderY),
            seg(sh.run[0], shoulderY, bodyLeft, pit));
      }
      // Sleeve length from the underarm: armpit out to the cuff.
      if (cuff && cuffX < bodyLeft) {
        const underarmY = cuff.run[1];
        put("sleeveInseam", Math.hypot(bodyLeft - cuffX, pit - underarmY),
            seg(bodyLeft, pit, cuffX, underarmY));
      }
    }

    /* Waist on a top: the narrowest row between the armpit and the hem, which
       is what "half way between armhole and hem" comes to on a flat garment. */
    let wy = -1, ww = Infinity;
    for (let y = pit + Math.round(s.h * 0.08); y <= hemY - Math.round(s.h * 0.05); y++) {
      if (s.widths[y] > 0 && s.runs[y] === 1 && s.widths[y] < ww) { ww = s.widths[y]; wy = y; }
    }
    if (wy > 0) {
      const waist = steadyRun(s, wy, 2);
      if (waist) put("waist", waist.w, seg(waist.run[0], wy, waist.run[1], wy));
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
    // Hip: the widest single row in the lower half, below the waist.
    let hy = -1, hw = -1;
    for (let y = s.top + Math.round(s.h * 0.45); y <= s.bottom - Math.round(s.h * 0.08); y++) {
      if (s.runs[y] === 1 && s.widths[y] > hw) { hw = s.widths[y]; hy = y; }
    }
    if (hy > 0) {
      const hip = steadyRun(s, hy, 2);
      if (hip) put("hip", hip.w, seg(hip.run[0], hy, hip.run[1], hy));
    }
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
