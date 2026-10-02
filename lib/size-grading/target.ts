/**
 * The printed calibration target: find it, and use it to make the photo square.
 *
 * WHY THIS EXISTS
 *
 * A photograph carries no depth. Hand-held, the camera is a different distance
 * from the garment every single shot, so without something of known size in
 * frame there is no way to turn pixels into centimetres — hold the phone 10%
 * higher and every measurement comes out 10% small. Tapping the two ends of a
 * sheet, which is what this replaces, solves exactly half of that: it gives a
 * scale at one spot and says nothing about the angle the photo was taken from.
 * Lean the phone 15° and a 60 cm length photographs as 58, with nothing on
 * screen to suggest anything is wrong.
 *
 * Four known points solve both at once. They fix the scale, and they reveal how
 * the plane is oriented, so the photo can be un-warped into a true top-down
 * view and measured there. Distance stops mattering, zoom stops mattering, and
 * tilt is corrected rather than silently absorbed into the numbers.
 *
 * WHAT THE TARGET IS
 *
 * A black rectangular frame — a ring, not a solid block — printed at an exact
 * size, with an orientation dot inside one corner. The ring matters: a solid
 * dark rectangle is indistinguishable from a folded black garment, a phone, or
 * a shadow, while a dark region with a large bright hole in the middle is not
 * something a warehouse floor produces by accident. Requiring the hole is what
 * makes detection trustworthy enough to run on every photo without asking.
 *
 * Everything here is pure functions over pixel buffers — no DOM — so the same
 * code runs in the browser and in the test scripts that prove the accuracy.
 */

import type { Point } from "./measure";

/**
 * The printed target, in centimetres.
 *
 * 18 × 24 cm leaves a comfortable margin on US Letter (21.59 × 27.94) so no
 * printer's unprintable edge clips a corner — a clipped corner is not a
 * slightly worse target, it is a wrong one. Deliberately NOT square: the aspect
 * ratio is what tells the detector which way round the target is lying.
 */
export const TARGET = {
  outerWCm: 18,
  outerHCm: 24,
  /** Thickness of the black ring. Thick enough to survive a cheap print. */
  borderCm: 2,
  /** Orientation dot, inside the ring near the top-left corner. */
  dotCm: 1.4,
  dotInsetCm: 1.0,
} as const;

/** Corners in the order top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export type TargetDetection = {
  quad: Quad;
  /** 0–1. How much this looked like the target rather than something dark. */
  confidence: number;
  /**
   * How far from square-on the shot was, as the worst disagreement between
   * opposite sides of the target, in percent. 0 is perfectly overhead.
   *
   * Deliberately NOT reported as an angle: recovering a true angle needs the
   * camera's focal length, which a browser does not give us, so a number of
   * degrees here would be invented. This is measured.
   */
  tiltPercent: number;
};

/* ───────────────────────────── binary helpers ───────────────────────────── */

function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) {
    g[i] = (rgba[p] * 299 + rgba[p + 1] * 587 + rgba[p + 2] * 114) / 1000;
  }
  return g;
}

/** Otsu's threshold — the split that best separates ink from paper. */
function otsu(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

/* ──────────────────────────────── detection ─────────────────────────────── */

type Component = {
  pixels: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  label: number;
};

/**
 * Find the target's four corners, or null.
 *
 * Corner precision is the dominant error in everything downstream: the target
 * is small next to a garment, so a corner one pixel out moves a measurement
 * taken 70 cm away by roughly four times that. Hence the sub-pixel edge fitting
 * in refineCorners — without it the same photos measured about 1 cm out, with
 * it they measure within half a millimetre of the corners' true position.
 */
export function detectTarget(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  /** Collects every sizeable candidate and the reason it was kept or rejected. */
  trace?: TargetCandidate[],
): TargetDetection | null {
  /* Work at up to 1200 px on the long edge. The app's own working image is
     1000 px, so in practice there is no downscale at all and no precision is
     thrown away before the edge fitting below can use it. */
  const scale = Math.min(1, 1200 / Math.max(width, height));
  const w = Math.max(16, Math.round(width * scale));
  const h = Math.max(16, Math.round(height * scale));
  const small = new Uint8Array(w * h);
  {
    const gray = toGray(rgba, width, height);
    /* Area-averaged, NOT nearest-neighbour.
     *
     * The ring is thin — two centimetres of an eighteen centimetre target — and
     * picking one source pixel per output pixel aliases it into a dotted line
     * that then fails the "is it a closed ring" test. That is not theoretical:
     * the same photo was found at 1004 px, LOST at 1400 and 1600, and found
     * again at 1800, purely from where the sampling grid happened to land.
     * Averaging the block each output pixel covers keeps the ring's contrast
     * and makes the answer stop depending on the photo's resolution. */
    for (let y = 0; y < h; y++) {
      const sy0 = Math.floor(y / scale);
      const sy1 = Math.min(height, Math.max(sy0 + 1, Math.floor((y + 1) / scale)));
      for (let x = 0; x < w; x++) {
        const sx0 = Math.floor(x / scale);
        const sx1 = Math.min(width, Math.max(sx0 + 1, Math.floor((x + 1) / scale)));
        let sum = 0;
        let n = 0;
        for (let yy = sy0; yy < sy1; yy++) {
          const row = yy * width;
          for (let xx = sx0; xx < sx1; xx++) {
            sum += gray[row + xx];
            n++;
          }
        }
        small[y * w + x] = n ? sum / n : gray[Math.min(height - 1, sy0) * width + Math.min(width - 1, sx0)];
      }
    }
  }

  /* Several thresholds, not one.
   *
   * A single global Otsu split assumes the target's ink is the dark thing in
   * the picture. On a warehouse table it often is not: the operator's photo had
   * a black chair and dark leggings pulling the threshold down, a wood table at
   * 146 and a ring that photographed at 113 — barely thirty levels apart, and
   * on the wrong side of the line. Sweeping a handful of thresholds and keeping
   * whichever produces the best-scoring ring costs a few passes over a small
   * image and removes a whole class of "it just doesn't find it". */
  let best: { det: TargetDetection; score: number } | null = null;
  const consider = (found: { det: TargetDetection; score: number } | null) => {
    if (found && (!best || found.score > best.score)) best = found;
  };
  const long = Math.max(w, h);
  /* Adaptive first — it is the cut that survives a grey print and a dark table.
     Two window sizes, because the window has to be wider than the ring is thick
     and the ring's size in pixels depends on how far away the phone was. The
     trace threshold is reported as negative so a diagnosis can tell them apart. */
  for (const win of [Math.round(long / 12), Math.round(long / 24)]) {
    for (const offset of [12, 24]) {
      consider(detectAtThreshold(small, w, h, -win, scale, trace, adaptiveInk(small, w, h, win, offset)));
      /* Every candidate that gets this far has already passed the pattern
         check — ink where the printed design has ink, at all four corners — so
         a good score is trustworthy and the rest of the search is wasted time.
         On the owner's photo stopping here took detection from 2.5 s to under
         one, which on a phone is the difference between waiting and not. */
      if (best && (best as { score: number }).score > 0.7 && !trace) return (best as { det: TargetDetection }).det;
    }
  }
  /* Then global cuts: a fixed ladder across the mid-tones — so a threshold
     between a grey ring and white paper is always tried, whatever the rest of
     the picture looks like — plus the picture's own Otsu and percentiles. */
  const ladder = [60, 90, 120, 150, 180];
  for (const t of [...new Set([...ladder, ...candidateThresholds(small)])].sort((a, b) => a - b)) {
    consider(detectAtThreshold(small, w, h, t, scale, trace));
    if (best && (best as { score: number }).score > 0.7 && !trace) break;
  }
  return (best as { det: TargetDetection; score: number } | null)?.det ?? null;
}

/** Otsu, plus a spread of percentile cuts around it. */
function candidateThresholds(gray: Uint8Array): number[] {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  const at = (fraction: number) => {
    let seen = 0;
    for (let t = 0; t < 256; t++) {
      seen += hist[t];
      if (seen >= total * fraction) return t;
    }
    return 255;
  };
  const out = new Set<number>([otsu(gray)]);
  for (const f of [0.04, 0.08, 0.14, 0.22, 0.3, 0.4, 0.5]) out.add(at(f));
  return [...out].filter((t) => t > 4 && t < 250).sort((a, b) => a - b);
}

/** One candidate the detector looked at, and what it decided — for diagnosis. */
export type TargetCandidate = {
  threshold: number;
  box: { x: number; y: number; w: number; h: number };
  fill: number;
  holeFraction?: number;
  aspectErr?: number;
  verdict: string;
};

/** Dilate then erode with a square of radius r — bridges gaps narrower than 2r. */
function closeMask(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const pass = (a: Uint8Array, keep: 0 | 1): Uint8Array => {
    // Separable: rows then columns. keep=1 dilates (any set), keep=0 erodes (all set).
    const tmp = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = keep === 1 ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const xx = x + d;
          const on = xx >= 0 && xx < w ? a[y * w + xx] : keep === 1 ? 0 : 1;
          if (keep === 1 ? on : !on) { v = keep; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    const out = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = keep === 1 ? 0 : 1;
        for (let d = -r; d <= r; d++) {
          const yy = y + d;
          const on = yy >= 0 && yy < h ? tmp[yy * w + x] : keep === 1 ? 0 : 1;
          if (keep === 1 ? on : !on) { v = keep; break; }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };
  return pass(pass(src, 1), 0);
}

/** A global cut: every pixel darker than t is ink. */
function globalInk(small: Uint8Array, t: number): Uint8Array {
  const dark = new Uint8Array(small.length);
  for (let i = 0; i < small.length; i++) if (small[i] < t) dark[i] = 1;
  return dark;
}

/**
 * An adaptive cut: a pixel is ink when it is darker than its own neighbourhood.
 *
 * This is the one that finds a badly printed target. The operator's printer put
 * the "black" ring down as grey 118, on a table photographed at 23 — and a
 * global threshold chosen from the whole picture's brightness lands below 115
 * every time, because the table is most of the picture, so the ring never once
 * counted as ink. Judged against its surroundings instead, a grey ring on white
 * paper is plainly darker than what is around it, while a large uniformly dark
 * table is not darker than itself and drops out entirely. That is exactly the
 * separation wanted, and it is why printed-marker detectors work this way.
 */
function adaptiveInk(small: Uint8Array, w: number, h: number, win: number, offset: number): Uint8Array {
  // Integral image, so every neighbourhood mean costs four lookups.
  const ii = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += small[y * w + x];
      ii[(y + 1) * (w + 1) + (x + 1)] = ii[y * (w + 1) + (x + 1)] + row;
    }
  }
  const r = Math.max(2, Math.round(win / 2));
  const dark = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = ii[y1 * (w + 1) + x1] - ii[y0 * (w + 1) + x1] - ii[y1 * (w + 1) + x0] + ii[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (small[y * w + x] < mean - offset) dark[y * w + x] = 1;
    }
  }
  return dark;
}

function detectAtThreshold(
  small: Uint8Array,
  w: number,
  h: number,
  t: number,
  scale: number,
  trace?: TargetCandidate[],
  ink?: Uint8Array,
): { det: TargetDetection; score: number } | null {
  /* Close thin gaps before asking whether the ring is closed. A cable lying
     across the sheet, a crease shadow or a streak of glare cuts a line through
     the ring, and an unbroken ring is the one thing every check below needs.
     The radius is small next to the paper margin outside the ring and the space
     inside it, so it bridges a gap without welding the ring to the table or to
     the dot. */
  const dark = closeMask(ink ?? globalInk(small, t), w, h, Math.max(1, Math.round(Math.max(w, h) / 400)));
  let darkN = 0;
  for (let i = 0; i < dark.length; i++) darkN += dark[i];
  // Nothing useful at the extremes, and labelling them is the expensive part.
  if (darkN < w * h * 0.002 || darkN > w * h * 0.7) return null;

  // Label dark components.
  const labels = new Int32Array(w * h).fill(-1);
  const comps: Component[] = [];
  const stack: number[] = [];
  for (let i = 0; i < dark.length; i++) {
    if (!dark[i] || labels[i] >= 0) continue;
    const label = comps.length;
    const c: Component = { pixels: 0, minX: w, maxX: -1, minY: h, maxY: -1, label };
    stack.push(i);
    labels[i] = label;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = (p / w) | 0;
      c.pixels++;
      if (x < c.minX) c.minX = x;
      if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y;
      if (y > c.maxY) c.maxY = y;
      if (x > 0 && dark[p - 1] && labels[p - 1] < 0) { labels[p - 1] = label; stack.push(p - 1); }
      if (x < w - 1 && dark[p + 1] && labels[p + 1] < 0) { labels[p + 1] = label; stack.push(p + 1); }
      if (y > 0 && dark[p - w] && labels[p - w] < 0) { labels[p - w] = label; stack.push(p - w); }
      if (y < h - 1 && dark[p + w] && labels[p + w] < 0) { labels[p + w] = label; stack.push(p + w); }
    }
    comps.push(c);
  }

  const frameArea = w * h;
  let best: { det: TargetDetection; score: number } | null = null;

  for (const c of comps) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const area = bw * bh;
    // Big enough to measure from, small enough not to be the whole photo.
    const meta: Partial<TargetCandidate> = {};
    const note = (verdict: string) => {
      if (trace && area >= frameArea * 0.004) {
        trace.push({
          threshold: t,
          box: { x: Math.round(c.minX / scale), y: Math.round(c.minY / scale), w: Math.round(bw / scale), h: Math.round(bh / scale) },
          fill: +(c.pixels / area).toFixed(3),
          ...meta,
          verdict,
        });
      }
    };
    if (area < frameArea * 0.004 || area > frameArea * 0.75) continue;
    if (bw < 12 || bh < 12) continue;

    /* The ring test, and it is a measurement rather than a sanity check.
     *
     * The target's proportions are known exactly: an 18 x 24 frame with a 2 cm
     * border is 14 x 20 of hole, so the hole is 64.8% of the bounding box and
     * the ink is the other 35.2%. Scoring against those numbers — rather than
     * accepting anything vaguely ring-shaped — is what stops a blurred photo
     * picking some other dark shape with a gap in it. Loose bounds here cost
     * two of the blurred test cases 13 cm. */
    const fill = c.pixels / area;
    if (fill < 0.16 || fill > 0.6) { note("fill out of range"); continue; }
    const holePixels = enclosedHoleArea(labels, w, c);
    const holeFraction = holePixels / area;
    meta.holeFraction = +holeFraction.toFixed(3);
    if (holeFraction < 0.3) { note("hole too small"); continue; }
    const EXPECTED_FILL = 1 - ((TARGET.outerWCm - 2 * TARGET.borderCm) * (TARGET.outerHCm - 2 * TARGET.borderCm)) /
      (TARGET.outerWCm * TARGET.outerHCm);
    const fillErr = Math.abs(fill - EXPECTED_FILL) / EXPECTED_FILL;
    if (fillErr > 0.75) { note("ink/hole ratio wrong"); continue; }

    const found = quadCorners(labels, w, c);
    if (!found) { note("no quad corners"); continue; }
    /* Two refinements, in order of authority.
     *
     * The binary one fits lines to the thresholded boundary, which is good but
     * inherits whatever the threshold did to the edge. The grey one puts each
     * edge where the brightness actually crosses between ink and background,
     * which no threshold can shift — and that matters because this function is
     * now called at several thresholds, and without it the sweep that made
     * detection reliable made the measurements worse. */
    const binary = refineCorners(found.pts, found.quad) ?? found.quad;
    const refined = refineCornersGray(small, w, h, binary) ?? binary;
    /* Does this quad actually reproduce the printed target? Everything above
       finds something ring-shaped; this is the step that checks it is OUR ring,
       by looking at where the ink and the paper have to be if the quad is
       right. A quad skewed by a tenth of its width puts the ring samples onto
       the table, and the check fails — which is the correct answer, because
       saying "no target" sends the operator to the four-corner tap, while
       accepting it silently measured 13 cm wrong. */
    if (!looksLikeTarget(small, w, h, refined)) { note("failed pattern check"); continue; }
    const quad = refined.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad;

    const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
    const top = side(quad[0], quad[1]);
    const bottom = side(quad[3], quad[2]);
    const left = side(quad[0], quad[3]);
    const right = side(quad[1], quad[2]);
    if (top < 8 || bottom < 8 || left < 8 || right < 8) { note("sides too short"); continue; }

    /* Opposite sides of a rectangle are equal; perspective makes the near one
       longer. The worst of the two disagreements is how far off square-on the
       shot was. */
    const tilt = Math.max(Math.abs(top / bottom - 1), Math.abs(left / right - 1)) * 100;

    /* The printed aspect is 18:24. Under perspective the measured aspect drifts,
       but a candidate whose aspect is nowhere near — either way up — is not the
       target. This is the check that rejects a dark picture frame or a doormat. */
    const aspect = ((top + bottom) / 2) / ((left + right) / 2);
    const want = TARGET.outerWCm / TARGET.outerHCm;
    const aspectErr = Math.min(Math.abs(aspect / want - 1), Math.abs(aspect / (1 / want) - 1));
    meta.aspectErr = +aspectErr.toFixed(3);
    if (aspectErr > 0.45) { note("aspect wrong"); continue; }

    /* Prefer, in order: the right proportions of ink to hole, the printed
       aspect ratio, a square-on shot, and size. The first two are what identify
       the target; the last two only break ties. */
    const score = (1 - Math.min(1, fillErr / 0.75)) * 0.4
      + (1 - Math.min(1, aspectErr / 0.45)) * 0.35
      + (1 - Math.min(1, tilt / 60)) * 0.15
      + Math.min(1, area / (frameArea * 0.25)) * 0.1;
    const confidence = Math.max(0, Math.min(1, score));
    note(`ACCEPTED score ${score.toFixed(2)}`);
    if (!best || score > best.score) best = { det: { quad, confidence, tiltPercent: tilt }, score };
  }

  return best;
}

/**
 * The four corners of a component that is a quadrilateral, whatever angle it
 * is lying at.
 *
 * The obvious method — take the extremes of x+y and x−y — is only correct while
 * the rectangle is roughly axis-aligned. Rotate it towards 45° and two corners
 * compete for the same extreme, the assignment flips, and the homography is
 * built from a mislabelled quad: at 40° of roll that put corners 24 px out and
 * the measurement 17 cm wrong.
 *
 * This takes the farthest point from the centroid, then the point farthest from
 * THAT (the opposite corner), then the farthest point either side of the line
 * between them. No axis is privileged, so rotation does not matter. The four
 * are returned wound consistently so the homography never comes out mirrored.
 */
function quadCorners(labels: Int32Array, w: number, c: Component): { quad: Quad; pts: Point[] } | null {
  /* Only boundary-ish points can be corners, and the left/right extreme of each
     row covers every one of them for a convex shape — far cheaper than hulling
     the whole component. */
  const pts: Point[] = [];
  for (let y = c.minY; y <= c.maxY; y++) {
    let lo = -1;
    let hi = -1;
    for (let x = c.minX; x <= c.maxX; x++) {
      if (labels[y * w + x] !== c.label) continue;
      if (lo < 0) lo = x;
      hi = x;
    }
    if (lo >= 0) {
      pts.push({ x: lo, y });
      if (hi !== lo) pts.push({ x: hi, y });
    }
  }
  // Column extremes too: row extremes alone describe the left and right edges
  // well and the top and bottom barely at all, and the line fitting below needs
  // all four.
  for (let x = c.minX; x <= c.maxX; x++) {
    let lo = -1;
    let hi = -1;
    for (let y = c.minY; y <= c.maxY; y++) {
      if (labels[y * w + x] !== c.label) continue;
      if (lo < 0) lo = y;
      hi = y;
    }
    if (lo >= 0) {
      pts.push({ x, y: lo });
      if (hi !== lo) pts.push({ x, y: hi });
    }
  }
  if (pts.length < 4) return null;

  let sx = 0;
  let sy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; }
  const cx = sx / pts.length;
  const cy = sy / pts.length;

  const far = (from: Point) => {
    let best = pts[0];
    let bestD = -1;
    for (const p of pts) {
      const d = (p.x - from.x) ** 2 + (p.y - from.y) ** 2;
      if (d > bestD) { bestD = d; best = p; }
    }
    return best;
  };
  const a = far({ x: cx, y: cy });
  const b = far(a);

  // Signed distance from the line a→b splits the remaining points into the two
  // sides; the farthest on each side are the other two corners.
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  let left: Point | null = null;
  let right: Point | null = null;
  let leftD = 0;
  let rightD = 0;
  for (const p of pts) {
    const s = ((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
    if (s > leftD) { leftD = s; left = p; }
    if (-s > rightD) { rightD = -s; right = p; }
  }
  if (!left || !right) return null;

  // Wind them consistently around the centroid.
  const four = [a, left, b, right];
  four.sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));

  /* Start on the corner that begins a SHORT side, so the quad always maps onto
     the printed 18 × 24 rectangle the same way round. A half-turn ambiguity
     remains and is harmless: rotating a measurement by 180° does not change it.
     Getting the short and long sides the wrong way round would, which is why
     this is decided here rather than assumed. */
  const sideLen = (i: number) => {
    const p = four[i];
    const q = four[(i + 1) % 4];
    return Math.hypot(q.x - p.x, q.y - p.y);
  };
  const start = sideLen(0) + sideLen(2) <= sideLen(1) + sideLen(3) ? 0 : 1;
  return {
    quad: [four[start % 4], four[(start + 1) % 4], four[(start + 2) % 4], four[(start + 3) % 4]],
    pts,
  };
}

/**
 * Sub-pixel corners, by fitting a line to each of the four edges and
 * intersecting them.
 *
 * A corner found by picking an extreme pixel is only ever as good as one pixel,
 * and worse where the print is soft or the threshold clipped it. An edge, by
 * contrast, is described by hundreds of boundary points, and a least-squares
 * line through them is accurate to a fraction of a pixel. Intersecting adjacent
 * edges then puts the corner where the two straight sides actually meet —
 * including where the real corner is slightly rounded by the printer, the
 * camera or the threshold, which is exactly where picking a pixel does worst.
 *
 * Points near the ends of an edge are left out: that is where the rounding is,
 * and including it would bend the very lines being fitted.
 */
function refineCorners(pts: Point[], quad: Quad): Quad | null {
  type Line = { px: number; py: number; dx: number; dy: number };
  const lines: Line[] = [];

  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 8) return null;
    const ux = ex / len;
    const uy = ey / len;

    const on: Point[] = [];
    for (const p of pts) {
      // Along the edge (0..len) and away from it.
      const t = (p.x - a.x) * ux + (p.y - a.y) * uy;
      if (t < len * 0.18 || t > len * 0.82) continue;
      const d = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
      if (d > Math.max(2.5, len * 0.03)) continue;
      on.push(p);
    }
    if (on.length < 8) return null;

    // Total least squares: the principal direction of the point cloud.
    let mx = 0;
    let my = 0;
    for (const p of on) { mx += p.x; my += p.y; }
    mx /= on.length;
    my /= on.length;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (const p of on) {
      const ddx = p.x - mx;
      const ddy = p.y - my;
      sxx += ddx * ddx;
      syy += ddy * ddy;
      sxy += ddx * ddy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ px: mx, py: my, dx: Math.cos(theta), dy: Math.sin(theta) });
  }

  const out: Point[] = [];
  for (let i = 0; i < 4; i++) {
    // Corner i is where edge (i-1) meets edge i.
    const l1 = lines[(i + 3) % 4];
    const l2 = lines[i];
    const det = l1.dx * -l2.dy - l1.dy * -l2.dx;
    if (Math.abs(det) < 1e-9) return null;
    const rx = l2.px - l1.px;
    const ry = l2.py - l1.py;
    const t = (rx * -l2.dy - ry * -l2.dx) / det;
    const p = { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
    // A refinement that moves a corner a long way is not a refinement.
    if (Math.hypot(p.x - quad[i].x, p.y - quad[i].y) > 12) return null;
    out.push(p);
  }
  return out as Quad;
}

/**
 * Verify a candidate against what the printed target must look like.
 *
 * Independent of how the corners were found: it maps the printed design onto
 * the image through the candidate's own homography and asks whether the ink is
 * where the ink should be and the paper where the paper should be. A shape that
 * passes every proportion test can still be the wrong shape, or the right shape
 * with one corner badly placed, and this is what separates those from a target.
 */
function looksLikeTarget(gray: Uint8Array, w: number, h: number, quad: Quad): boolean {
  const W = TARGET.outerWCm;
  const Hc = TARGET.outerHCm;
  const b = TARGET.borderCm;
  const H = homography(
    [
      { x: 0, y: 0 },
      { x: W, y: 0 },
      { x: W, y: Hc },
      { x: 0, y: Hc },
    ],
    quad,
  );
  if (!H) return false;

  const read = (cmX: number, cmY: number): number | null => {
    const p = applyH(H, cmX, cmY);
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    return gray[y * w + x];
  };

  const ink: Array<number | null> = [];
  const paper: Array<number | null> = [];
  const mid = b / 2; // the middle of the printed border
  for (let t = 0.12; t <= 0.88; t += 0.04) {
    // Along the middle of each of the four bars — this must be ink.
    ink.push(read(W * t, mid), read(W * t, Hc - mid));
    ink.push(read(mid, Hc * t), read(W - mid, Hc * t));
    // Just inside the ring — this must be paper. The orientation dot and the
    // printed text live in the upper half, so the lower half is sampled.
    paper.push(read(W * (0.3 + 0.4 * t), Hc * 0.72));
  }
  /* The four corners of the ring, sampled on their own and judged strictly.
     A quad can be right along its sides and wrong at one corner — that is the
     shape of the failure this exists to catch — and corner samples are the only
     ones that move off the ink when it happens. */
  const corners = [
    read(mid, mid),
    read(W - mid, mid),
    read(W - mid, Hc - mid),
    read(mid, Hc - mid),
  ];

  const clean = (a: Array<number | null>): number[] =>
    a.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const inkV = clean(ink);
  const paperV = clean(paper);
  if (inkV.length < 20 || paperV.length < 8) return false;

  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const inkMean = mean(inkV);
  const paperMean = mean(paperV);
  // Ink has to be meaningfully darker than the paper it surrounds.
  if (paperMean - inkMean < 28) return false;

  // And it has to be darker almost everywhere, not merely on average: an
  // average survives a quad that is half on the ring and half on the table.
  const cut = (inkMean + paperMean) / 2;
  const inkOk = inkV.filter((v) => v < cut).length / inkV.length;
  const paperOk = paperV.filter((v) => v > cut).length / paperV.length;
  const cornerV = clean(corners);
  if (cornerV.length < 4 || cornerV.some((v) => v >= cut)) return false;
  return inkOk >= 0.85 && paperOk >= 0.8;
}

/**
 * Put each edge where the brightness crosses, not where the threshold fell.
 *
 * A corner taken from a binary image is only ever as good as the threshold that
 * made it, and this detector deliberately tries several. Sampling the grey
 * profile across each edge removes that dependency: along a line crossing the
 * target's boundary the brightness runs from ink to background, and the edge is
 * where it passes the half-way point between the two. That half-way point does
 * not move when the threshold does.
 *
 * The levels are taken from each individual profile rather than globally, so it
 * works whether the target is lying on a pale table or a dark floor — the only
 * requirement is that the two sides of the edge differ, which is what being an
 * edge means.
 */
function refineCornersGray(gray: Uint8Array, w: number, h: number, quad: Quad): Quad | null {
  const sample = (x: number, y: number): number => {
    const fx = Math.max(0, Math.min(w - 2, Math.floor(x)));
    const fy = Math.max(0, Math.min(h - 2, Math.floor(y)));
    const ax = Math.max(0, Math.min(1, x - fx));
    const ay = Math.max(0, Math.min(1, y - fy));
    const i = fy * w + fx;
    return (
      gray[i] * (1 - ax) * (1 - ay) +
      gray[i + 1] * ax * (1 - ay) +
      gray[i + w] * (1 - ax) * ay +
      gray[i + w + 1] * ax * ay
    );
  };

  type Line = { px: number; py: number; dx: number; dy: number };
  const lines: Line[] = [];
  const REACH = 5; // how far either side of the edge to look, in pixels

  for (let e = 0; e < 4; e++) {
    const a = quad[e];
    const b = quad[(e + 1) % 4];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 12) return null;
    const ux = ex / len;
    const uy = ey / len;
    // Outward normal: away from the quad's centre.
    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let nx = -uy;
    let ny = ux;
    if ((mx - cx) * nx + (my - cy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }

    const crossings: Point[] = [];
    const STEPS = 48;
    for (let s0 = 0; s0 <= STEPS; s0++) {
      const t = 0.15 + (0.7 * s0) / STEPS; // skip the rounded corners
      const px = a.x + ex * t;
      const py = a.y + ey * t;

      // Profile across the edge, inside → outside.
      let lo = Infinity;
      let hi = -Infinity;
      const prof: number[] = [];
      for (let d = -REACH; d <= REACH; d += 0.5) {
        const v = sample(px + nx * d, py + ny * d);
        prof.push(v);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (hi - lo < 18) continue; // no real edge here — a gap in the print, or glare
      const mid = (lo + hi) / 2;

      // First crossing of the mid level, with linear interpolation.
      let found = NaN;
      for (let k = 1; k < prof.length; k++) {
        const v0 = prof[k - 1];
        const v1 = prof[k];
        if ((v0 - mid) * (v1 - mid) <= 0 && v0 !== v1) {
          const f = (mid - v0) / (v1 - v0);
          found = -REACH + (k - 1 + f) * 0.5;
          break;
        }
      }
      if (!Number.isFinite(found)) continue;
      crossings.push({ x: px + nx * found, y: py + ny * found });
    }
    if (crossings.length < 12) return null;

    // Total least squares, then one pass discarding the worst outliers.
    const fit = (pts: Point[]): Line => {
      let sx = 0;
      let sy = 0;
      for (const p of pts) { sx += p.x; sy += p.y; }
      const mx2 = sx / pts.length;
      const my2 = sy / pts.length;
      let sxx = 0;
      let syy = 0;
      let sxy = 0;
      for (const p of pts) {
        const dx2 = p.x - mx2;
        const dy2 = p.y - my2;
        sxx += dx2 * dx2;
        syy += dy2 * dy2;
        sxy += dx2 * dy2;
      }
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      return { px: mx2, py: my2, dx: Math.cos(theta), dy: Math.sin(theta) };
    };
    let line = fit(crossings);
    const resid = crossings.map((p) => Math.abs((p.x - line.px) * line.dy - (p.y - line.py) * line.dx));
    const sorted = [...resid].sort((x, y) => x - y);
    const cut = Math.max(1.2, sorted[Math.floor(sorted.length * 0.8)]);
    const kept = crossings.filter((_, i) => resid[i] <= cut);
    if (kept.length >= 10) line = fit(kept);
    lines.push(line);
  }

  const out: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const l1 = lines[(i + 3) % 4];
    const l2 = lines[i];
    const det = l1.dx * -l2.dy - l1.dy * -l2.dx;
    if (Math.abs(det) < 1e-9) return null;
    const rx = l2.px - l1.px;
    const ry = l2.py - l1.py;
    const t = (rx * -l2.dy - ry * -l2.dx) / det;
    const p = { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
    if (Math.hypot(p.x - quad[i].x, p.y - quad[i].y) > 10) return null;
    out.push(p);
  }
  return out as Quad;
}

/** How many pixels this component encloses that its outside cannot reach. */
function enclosedHoleArea(labels: Int32Array, w: number, c: Component): number {
  const bw = c.maxX - c.minX + 1;
  const bh = c.maxY - c.minY + 1;
  // Flood the NOT-component pixels inward from the bounding box edge; anything
  // left unvisited is enclosed by the component.
  const seen = new Uint8Array(bw * bh);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * bw + x;
    if (seen[i]) return;
    if (labels[(y + c.minY) * w + (x + c.minX)] === c.label) return;
    seen[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < bw; x++) { push(x, 0); push(x, bh - 1); }
  for (let y = 0; y < bh; y++) { push(0, y); push(bw - 1, y); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % bw;
    const y = (i / bw) | 0;
    if (x > 0) push(x - 1, y);
    if (x < bw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < bh - 1) push(x, y + 1);
  }
  let hole = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (seen[y * bw + x]) continue;
      if (labels[(y + c.minY) * w + (x + c.minX)] === c.label) continue;
      hole++;
    }
  }
  return hole;
}

/**
 * Four tapped corners, in whatever order they were tapped, as a quad in the
 * order the homography expects.
 *
 * Asking an operator to tap "clockwise from the top-left" is asking for a twisted
 * quad the first time someone starts at another corner — and a twisted quad
 * gives a confidently wrong scale with no error. So the order is ignored: the
 * points are wound around their centre and started on a short side, exactly as
 * detected corners are.
 */
export function orderQuad(points: Point[]): Quad {
  const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
  const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
  const four = [...points].sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
  const side = (i: number) => Math.hypot(four[(i + 1) % 4].x - four[i].x, four[(i + 1) % 4].y - four[i].y);
  const start = side(0) + side(2) <= side(1) + side(3) ? 0 : 1;
  return [four[start % 4], four[(start + 1) % 4], four[(start + 2) % 4], four[(start + 3) % 4]];
}

/* ─────────────────────────────── homography ─────────────────────────────── */

export type Homography = Float64Array; // 9 entries, row-major

/** Solve A·x = b by Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[pivot][i])) pivot = r;
    if (Math.abs(A[pivot][i]) < 1e-12) return null;
    [A[i], A[pivot]] = [A[pivot], A[i]];
    [b[i], b[pivot]] = [b[pivot], b[i]];
    for (let r = i + 1; r < n; r++) {
      const f = A[r][i] / A[i][i];
      if (!f) continue;
      for (let ccc = i; ccc < n; ccc++) A[r][ccc] -= f * A[i][ccc];
      b[r] -= f * b[i];
    }
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

/**
 * The transform from flat-world coordinates to the photo.
 *
 * `src` are four points in the world (centimetres on the table), `dst` the same
 * four points as they appear in the image. Eight unknowns, eight equations.
 */
export function homography(src: Quad, dst: Quad): Homography | null {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const s = solve(A, b);
  if (!s) return null;
  return Float64Array.from([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], 1]);
}

export function applyH(H: Homography, x: number, y: number): Point {
  const d = H[6] * x + H[7] * y + H[8];
  if (Math.abs(d) < 1e-12) return { x: 0, y: 0 };
  return { x: (H[0] * x + H[1] * y + H[2]) / d, y: (H[3] * x + H[4] * y + H[5]) / d };
}

/* ──────────────────────────────── rectify ───────────────────────────────── */

/**
 * Where the squared-up image sits in the world (target centimetres, the
 * target's top-left at 0,0): output pixel (ox, oy) is the point
 * u = minU + ox / pxPerCm, v = minV + oy / pxPerCm in a frame turned by
 * `angle` from the target's own axes. Kept so a second image — the garment
 * mask — can be warped onto exactly the same pixels.
 */
export type RectFrame = {
  angle: number;
  minU: number;
  minV: number;
  pxPerCm: number;
  width: number;
  height: number;
};

export type Rectified = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Exact, by construction — this is the whole point of rectifying. */
  pxPerCm: number;
  frame: RectFrame;
  /** The target's four corners, in output pixels. */
  targetOut: Quad;
};

/** World centimetres → output pixels of a frame. */
export function worldToFrame(f: RectFrame, x: number, y: number): Point {
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  return { x: (c * x + s * y - f.minU) * f.pxPerCm, y: (-s * x + c * y - f.minV) * f.pxPerCm };
}

/** A frame's output pixel → the photo pixel it was sampled from. */
export function frameToSource(quad: Quad, f: RectFrame, ox: number, oy: number): Point {
  const W = TARGET.outerWCm, Hc = TARGET.outerHCm;
  const H = homography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hc }, { x: 0, y: Hc }], quad);
  const c = Math.cos(f.angle), s = Math.sin(f.angle);
  const u = f.minU + ox / f.pxPerCm, v = f.minV + oy / f.pxPerCm;
  return H ? applyH(H, c * u - s * v, s * u + c * v) : { x: ox, y: oy };
}

/** How far the paper reaches past the printed ring, in cm. */
export const SHEET_CM = 2.5;

/** The sheet the target is printed on, in a frame's output pixels. */
export function targetSheet(f: RectFrame): Quad {
  const m = SHEET_CM, W = TARGET.outerWCm, Hc = TARGET.outerHCm;
  return [[-m, -m], [W + m, -m], [W + m, Hc + m], [-m, Hc + m]].map(([x, y]) => worldToFrame(f, x, y)) as Quad;
}

/** Whether a point is inside a convex quad (either winding). */
export function insideQuad(q: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cr === 0) continue;
    if (sign === 0) sign = Math.sign(cr);
    else if (Math.sign(cr) !== sign) return false;
  }
  return true;
}

/** The furthest from the target the squared-up image ever reaches, in cm. */
const FRAME_CAP_CM = 150;

/**
 * The frame that shows the photo the way it was taken: the photo's "down"
 * stays down, and the window covers the photo rather than a fixed square
 * around the target.
 *
 * Squaring up to the target's own axes turned the whole picture by however
 * crooked the sheet lay, and a fixed window round the target left the rest
 * white — the owner's photo came back as a tilted photo on a white page.
 * A rotation changes nothing about the scale, so the measurement is the same;
 * only the picture now looks like the one that was taken.
 */
function uprightFrame(width: number, height: number, quad: Quad, maxPx: number): RectFrame | null {
  const W = TARGET.outerWCm, Hc = TARGET.outerHCm;
  const world: Quad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: Hc }, { x: 0, y: Hc }];
  const inv = homography(quad, world);
  if (!inv) return null;
  // The photo's "down", in world terms, at the target.
  const pc = { x: (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4, y: (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4 };
  const a0 = applyH(inv, pc.x, pc.y);
  const a1 = applyH(inv, pc.x, pc.y + Math.max(4, height / 50));
  const dx = a1.x - a0.x, dy = a1.y - a0.y, n = Math.hypot(dx, dy) || 1;
  const angle = Math.atan2(-dx / n, dy / n);
  const c = Math.cos(angle), s = Math.sin(angle);
  // The photo's border in that frame, sampled, clamped near the target.
  const cx = W / 2, cy = Hc / 2;
  const cu = c * cx + s * cy, cv = -s * cx + c * cy;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const STEPS = 24;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    for (const [px, py] of [[t * width, 0], [t * width, height], [0, t * height], [width, t * height]]) {
      const d = inv[6] * px + inv[7] * py + inv[8];
      if (d <= 1e-9) continue; // behind the camera: the horizon, not the table
      const w = applyH(inv, px, py);
      const u = Math.max(cu - FRAME_CAP_CM, Math.min(cu + FRAME_CAP_CM, c * w.x + s * w.y));
      const v = Math.max(cv - FRAME_CAP_CM, Math.min(cv + FRAME_CAP_CM, -s * w.x + c * w.y));
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
  }
  if (!(maxU - minU > 10 && maxV - minV > 10)) return null;
  const pxPerCm = Math.min(maxPx / (maxU - minU), maxPx / (maxV - minV));
  return {
    angle, minU, minV, pxPerCm,
    width: Math.max(16, Math.round((maxU - minU) * pxPerCm)),
    height: Math.max(16, Math.round((maxV - minV) * pxPerCm)),
  };
}

/**
 * Re-render the photo as if it had been taken from straight above.
 *
 * The output is in centimetre space at a chosen resolution, so `pxPerCm` is not
 * estimated from anything: it is whatever we decided to render at. Every
 * measurement taken on this image is therefore in real centimetres, with the
 * camera's angle already divided out.
 *
 * The region covered is clamped near the target rather than taken from the
 * photo's corners unchecked, because under strong perspective the far corners
 * of an image map to enormous — occasionally negative — world coordinates, and
 * sizing a canvas from those numbers is how a browser tab dies.
 *
 * `upright` follows the photo's orientation and covers the whole photo (what
 * the app shows); without it the frame is the target's own axes with
 * `aroundCm` either side. `frame` reuses an earlier call's frame exactly.
 */
export function rectify(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  quad: Quad,
  /** fill: value written where the output falls outside the photo. */
  opts?: { maxPx?: number; aroundCm?: number; pxPerCm?: number; fill?: number; upright?: boolean; frame?: RectFrame },
): Rectified | null {
  const maxPx = opts?.maxPx ?? 1100;
  const around = opts?.aroundCm ?? 70; // a garment reaches ~70 cm from the target
  const W = TARGET.outerWCm;
  const Hc = TARGET.outerHCm;
  // The target's own corners in world centimetres, with its top-left at (0,0).
  const world: Quad = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: Hc },
    { x: 0, y: Hc },
  ];
  const H = homography(world, quad);
  if (!H) return null;

  let frame = opts?.frame ?? (opts?.upright ? uprightFrame(width, height, quad, maxPx) : null);
  if (!frame) {
    const pxPerCm = opts?.pxPerCm ?? Math.min(maxPx / (W + 2 * around), maxPx / (Hc + 2 * around));
    frame = {
      angle: 0, minU: -around, minV: -around, pxPerCm,
      width: Math.max(16, Math.round((W + 2 * around) * pxPerCm)),
      height: Math.max(16, Math.round((Hc + 2 * around) * pxPerCm)),
    };
  }
  const { pxPerCm, width: outW, height: outH } = frame;
  const c = Math.cos(frame.angle), s = Math.sin(frame.angle);

  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const v = frame.minV + oy / pxPerCm;
    for (let ox = 0; ox < outW; ox++) {
      const u = frame.minU + ox / pxPerCm;
      const p = applyH(H, c * u - s * v, s * u + c * v);
      const o = (oy * outW + ox) * 4;
      // Bilinear: the resampling is the only place this step can lose an edge,
      // and nearest-neighbour would cost more than the tilt correction gains.
      const fx = Math.floor(p.x);
      const fy = Math.floor(p.y);
      if (fx < 0 || fy < 0 || fx >= width - 1 || fy >= height - 1) {
        /* Outside the photo. White for a picture; 0 for a mask, where white would
           mean "garment" and turn the whole frame into one. */
        out[o] = out[o + 1] = out[o + 2] = opts?.fill ?? 255;
        out[o + 3] = 255;
        continue;
      }
      const ax = p.x - fx;
      const ay = p.y - fy;
      const i00 = (fy * width + fx) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + width * 4;
      const i11 = i01 + 4;
      for (let k = 0; k < 3; k++) {
        out[o + k] =
          rgba[i00 + k] * (1 - ax) * (1 - ay) +
          rgba[i10 + k] * ax * (1 - ay) +
          rgba[i01 + k] * (1 - ax) * ay +
          rgba[i11 + k] * ax * ay;
      }
      out[o + 3] = 255;
    }
  }
  const targetOut = world.map((q) => worldToFrame(frame, q.x, q.y)) as Quad;
  return { data: out, width: outW, height: outH, pxPerCm, frame, targetOut };
}
