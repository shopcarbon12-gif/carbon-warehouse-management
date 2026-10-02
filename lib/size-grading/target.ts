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
    for (let y = 0; y < h; y++) {
      const sy = Math.min(height - 1, Math.round(y / scale));
      for (let x = 0; x < w; x++) {
        small[y * w + x] = gray[sy * width + Math.min(width - 1, Math.round(x / scale))];
      }
    }
  }

  const t = otsu(small);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < dark.length; i++) dark[i] = small[i] < t ? 1 : 0;

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
    if (area < frameArea * 0.004 || area > frameArea * 0.75) continue;
    if (bw < 12 || bh < 12) continue;

    /* The ring test. The target is a frame, so most of its bounding box is the
       bright hole in the middle; a solid dark object fills its box. This single
       check is what keeps a black garment, a phone or a shadow from being
       mistaken for the target. */
    const fill = c.pixels / area;
    if (fill < 0.12 || fill > 0.72) continue;
    if (!hasEnclosedHole(labels, w, h, c)) continue;

    const found = quadCorners(labels, w, c);
    if (!found) continue;
    /* Refine before scaling back. Corner precision is the single biggest term
       in the final error: the target is small next to the garment, so a corner
       that is one pixel out moves a measurement taken 70 cm away by roughly
       four times that. */
    const refined = refineCorners(found.pts, found.quad) ?? found.quad;
    const quad = refined.map((p) => ({ x: p.x / scale, y: p.y / scale })) as Quad;

    const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
    const top = side(quad[0], quad[1]);
    const bottom = side(quad[3], quad[2]);
    const left = side(quad[0], quad[3]);
    const right = side(quad[1], quad[2]);
    if (top < 8 || bottom < 8 || left < 8 || right < 8) continue;

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
    if (aspectErr > 0.45) continue;

    // Prefer: closer to the printed aspect, squarer to the camera, bigger.
    const score = (1 - Math.min(1, aspectErr / 0.45)) * 0.5
      + (1 - Math.min(1, tilt / 60)) * 0.3
      + Math.min(1, area / (frameArea * 0.25)) * 0.2;
    const confidence = Math.max(0, Math.min(1, score));
    if (!best || score > best.score) best = { det: { quad, confidence, tiltPercent: tilt }, score };
  }

  return best?.det ?? null;
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

/** Does this component enclose a bright region that the border cannot reach? */
function hasEnclosedHole(labels: Int32Array, w: number, h: number, c: Component): boolean {
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
  // A real frame's hole is most of its box; a nick in a solid shape is not.
  return hole > bw * bh * 0.1;
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

export type Rectified = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Exact, by construction — this is the whole point of rectifying. */
  pxPerCm: number;
};

/**
 * Re-render the photo as if it had been taken from straight above.
 *
 * The output is in centimetre space at a chosen resolution, so `pxPerCm` is not
 * estimated from anything: it is whatever we decided to render at. Every
 * measurement taken on this image is therefore in real centimetres, with the
 * camera's angle already divided out.
 *
 * The region covered is clamped around the target rather than taken from the
 * photo's corners, because under strong perspective the far corners of an image
 * map to enormous — occasionally negative — world coordinates, and sizing a
 * canvas from those numbers is how a browser tab dies.
 */
export function rectify(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  quad: Quad,
  opts?: { maxPx?: number; aroundCm?: number; pxPerCm?: number },
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

  const minX = -around;
  const minY = -around;
  const maxX = W + around;
  const maxY = Hc + around;
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const pxPerCm = opts?.pxPerCm ?? Math.min(maxPx / spanX, maxPx / spanY);
  const outW = Math.max(16, Math.round(spanX * pxPerCm));
  const outH = Math.max(16, Math.round(spanY * pxPerCm));

  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let oy = 0; oy < outH; oy++) {
    const wy = minY + oy / pxPerCm;
    for (let ox = 0; ox < outW; ox++) {
      const wx = minX + ox / pxPerCm;
      const p = applyH(H, wx, wy);
      const o = (oy * outW + ox) * 4;
      // Bilinear: the resampling is the only place this step can lose an edge,
      // and nearest-neighbour would cost more than the tilt correction gains.
      const fx = Math.floor(p.x);
      const fy = Math.floor(p.y);
      if (fx < 0 || fy < 0 || fx >= width - 1 || fy >= height - 1) {
        out[o] = out[o + 1] = out[o + 2] = 255;
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
  return { data: out, width: outW, height: outH, pxPerCm };
}
