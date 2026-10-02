/**
 * Flat-lay T-shirt measurement from a photo.
 *
 * Pure functions over an RGBA pixel buffer — no DOM, no canvas — so the same
 * code runs in the browser and in node test scripts.
 *
 * Assumptions (the operator guide on the page tells staff to follow them):
 *   - The shirt lies flat, front up, collar at the TOP of the photo.
 *   - The background is plain and contrasts with the shirt.
 *   - The photo is taken straight from above.
 *
 * Pipeline:
 *   1. Background model = a colour plane (per channel, a + b·x + c·y) fitted to
 *      the photo's outer border ring, so a lighting gradient across the table
 *      doesn't read as "shirt".
 *   2. Foreground = pixels whose colour is far enough from the modelled
 *      background at that spot.
 *   3. Clean-up (close → open), keep the largest blob (the shirt — a smaller
 *      reference card or ruler is dropped), fill holes (prints that happen to
 *      match the background).
 *   4. Points of measure, read row by row from the mask:
 *        - Body length:  top of shirt (HPS / collar) → bottom of hem.
 *        - Armpit:       scanning up from the hem, the first row where the run
 *                        through the body centre suddenly widens (the sleeves
 *                        join the body there).
 *        - Chest width:  body width 2.5 cm (1") below the armpit, flat.
 *        - Hem width:    body width just above the bottom edge, flat.
 */

export type Point = { x: number; y: number };
export type Segment = { a: Point; b: Point };

export type ShirtMask = {
  width: number;
  height: number;
  /** 1 = shirt, 0 = background. */
  data: Uint8Array;
  /** Number of shirt pixels. */
  area: number;
};

export type ShirtMeasurementsPx = {
  /** Flat chest width (pit-to-pit, 1" below armpit), pixels. */
  chest: number;
  /** HPS / top → hem, pixels. */
  length: number;
  /** Flat hem width, pixels. */
  hem: number;
  lines: { chest: Segment; length: Segment; hem: Segment };
  armpitY: number;
};

export type MeasureResult =
  | { ok: true; mask: ShirtMask; px: ShirtMeasurementsPx }
  | { ok: false; error: string; mask?: ShirtMask };

/** Distance (RGB, 0–441) a pixel must be from the background to count as shirt. */
export const DEFAULT_THRESHOLD = 48;

/**
 * How far each pixel sits from the modelled background, 0–441.
 * Kept separate so the threshold can be chosen from the distribution rather
 * than guessed, and so the same distances are reused for the mask.
 */
function backgroundDistance(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint16Array {
  const bg = fitBackground(rgba, width, height);
  const out = new Uint16Array(width * height);
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      const p = i * 4;
      const dr = rgba[p] - (bg[0][0] + bg[0][1] * x + bg[0][2] * y);
      const dg = rgba[p + 1] - (bg[1][0] + bg[1][1] * x + bg[1][2] * y);
      const db = rgba[p + 2] - (bg[2][0] + bg[2][1] * x + bg[2][2] * y);
      out[i] = Math.round(Math.sqrt(dr * dr + dg * dg + db * db));
    }
  }
  return out;
}

/**
 * Pick the cut between "background" and "garment" from this photo's own
 * distances (Otsu), instead of a fixed number.
 *
 * A fixed 48 is right for a navy shirt on a white table and wrong for a cream
 * shirt on a grey one — and when it is wrong the green covers the wrong thing,
 * which is exactly the failure an operator sees. Clamped, because a photo with
 * no garment in it would otherwise produce a meaningless split.
 */
export function autoThreshold(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): number {
  const dist = backgroundDistance(rgba, width, height);
  const BINS = 256;
  const hist = new Float64Array(BINS);
  for (let i = 0; i < dist.length; i++) hist[Math.min(BINS - 1, dist[i])]++;
  let total = 0, sum = 0;
  for (let b = 0; b < BINS; b++) { total += hist[b]; sum += b * hist[b]; }
  let wB = 0, sumB = 0, best = 0, bestVar = -1;
  for (let b = 0; b < BINS; b++) {
    wB += hist[b];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) { bestVar = between; best = b; }
  }
  return Math.max(15, Math.min(120, best));
}

/**
 * Grow the garment outward from the pixel the operator tapped.
 *
 * The border-ring background model below assumes a plain sweep. Photographed
 * on a warehouse floor it fails badly and silently: the border is floorboards,
 * a dark pile at one edge and the operator's own feet, so the fitted
 * "background" is meaningless, the lit part of the floor becomes foreground,
 * and the largest blob is a patch of floor — the garment never even competes.
 *
 * Growing from a tap needs no background model at all. It takes the colour
 * where the operator pointed and spreads while the colour holds, which is what
 * "this garment" actually means and is unaffected by whatever else is in frame.
 *
 * `tolerance` is the RGB distance a pixel may differ from the seed colour.
 */
export function segmentFromSeed(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seed: Point,
  tolerance: number,
): ShirtMask {
  const n = width * height;
  const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)));

  /* Median of a small patch, not the single pixel: a tap can land on a seam, a
     print or a specular highlight, none of which is the garment's colour. */
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const R = 4;
  for (let y = Math.max(0, sy - R); y <= Math.min(height - 1, sy + R); y++) {
    for (let x = Math.max(0, sx - R); x <= Math.min(width - 1, sx + R); x++) {
      const p = (y * width + x) * 4;
      rs.push(rgba[p]); gs.push(rgba[p + 1]); bs.push(rgba[p + 2]);
    }
  }
  const mid = (a: number[]) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  const sr = mid(rs), sg = mid(gs), sb = mid(bs);

  const t2 = tolerance * tolerance;
  let fg: Uint8Array = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const start = sy * width + sx;
  fg[start] = 1;
  stack[sp++] = start;
  const close = (i: number) => {
    const p = i * 4;
    const dr = rgba[p] - sr, dg = rgba[p + 1] - sg, db = rgba[p + 2] - sb;
    return dr * dr + dg * dg + db * db <= t2;
  };
  while (sp) {
    const p = stack[--sp];
    const x = p % width;
    const visit = (q: number) => {
      if (!fg[q] && close(q)) { fg[q] = 1; stack[sp++] = q; }
    };
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (p >= width) visit(p - width);
    if (p < width * (height - 1)) visit(p + width);
  }

  const r = Math.max(1, Math.round(Math.min(width, height) / 300));
  fg = erode(dilate(fg, width, height, r), width, height, r); // seal seams and creases
  fg = dilate(erode(fg, width, height, r), width, height, r); // drop speckle
  fg = fillHoles(fg, width, height);
  let area = 0;
  for (let i = 0; i < n; i++) area += fg[i];
  return { width, height, data: fg, area };
}

/**
 * A starting tolerance for the seeded grow, from how varied the garment's own
 * colour is around the tap — a flat jersey needs a tight tolerance, a textured
 * or creased fabric a looser one.
 */
export function autoSeedTolerance(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seed: Point,
): number {
  const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)));
  const R = Math.max(6, Math.round(Math.min(width, height) * 0.02));
  const vals: number[] = [];
  for (let y = Math.max(0, sy - R); y <= Math.min(height - 1, sy + R); y += 2) {
    for (let x = Math.max(0, sx - R); x <= Math.min(width - 1, sx + R); x += 2) {
      const p = (y * width + x) * 4;
      vals.push(rgba[p], rgba[p + 1], rgba[p + 2]);
    }
  }
  let mean = 0;
  for (const v of vals) mean += v;
  mean /= Math.max(1, vals.length);
  let varsum = 0;
  for (const v of vals) varsum += (v - mean) * (v - mean);
  const sd = Math.sqrt(varsum / Math.max(1, vals.length));
  return Math.max(28, Math.min(110, Math.round(28 + sd * 2.4)));
}

export function segmentShirt(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  threshold = DEFAULT_THRESHOLD,
  /** Pixel the operator tapped on the garment — picks that shape, not the biggest. */
  seed?: Point | null,
): ShirtMask {
  const dist = backgroundDistance(rgba, width, height);
  const n = width * height;
  let fg: Uint8Array = new Uint8Array(n);
  for (let i = 0; i < n; i++) fg[i] = dist[i] > threshold ? 1 : 0;
  const r = Math.max(1, Math.round(Math.min(width, height) / 300));
  fg = erode(dilate(fg, width, height, r), width, height, r); // close: seal seams/creases
  fg = dilate(erode(fg, width, height, r), width, height, r); // open: drop speckle
  fg = componentFor(fg, width, height, seed ?? null);
  fg = fillHoles(fg, width, height);
  let area = 0;
  for (let i = 0; i < n; i++) area += fg[i];
  return { width, height, data: fg, area };
}

export function measureMask(mask: ShirtMask, pxPerCm: number): MeasureResult {
  const { width, height, data } = mask;
  if (mask.area < width * height * 0.03) {
    return { ok: false, error: "No shirt found. Use a plain background that contrasts with the shirt.", mask };
  }

  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let any = false;
    for (let x = 0; x < width; x++) {
      if (data[row + x]) {
        any = true;
        break;
      }
    }
    if (any) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  const shirtH = bottom - top;
  if (top < 0 || shirtH < 20) return { ok: false, error: "Shirt too small in the photo.", mask };
  if (top <= 1 || bottom >= height - 2) {
    return { ok: false, error: "Shirt touches the photo edge — step back so the whole shirt is in frame.", mask };
  }

  // Body centre: average midpoint of the rows in the bottom quarter (below the sleeves).
  let sumMid = 0;
  let cnt = 0;
  for (let y = bottom - Math.round(shirtH * 0.25); y <= bottom - Math.round(shirtH * 0.03); y++) {
    const ext = rowExtent(data, width, y);
    if (ext) {
      sumMid += (ext[0] + ext[1]) / 2;
      cnt++;
    }
  }
  if (!cnt) return { ok: false, error: "Could not find the shirt body.", mask };
  const cx = Math.round(sumMid / cnt);

  const runAt = (y: number) => centerRun(data, width, y, cx);
  const medianRun = (y: number, span: number) => {
    const ws: { w: number; run: [number, number] }[] = [];
    for (let yy = y - span; yy <= y + span; yy++) {
      if (yy < top || yy > bottom) continue;
      const run = runAt(yy);
      if (run) ws.push({ w: run[1] - run[0] + 1, run });
    }
    if (!ws.length) return null;
    ws.sort((a, b) => a.w - b.w);
    return ws[ws.length >> 1];
  };

  // Hem: just above the bottom edge (avoid the rounded/folded last rows).
  const hemY = bottom - Math.max(2, Math.round(shirtH * 0.02));
  const hem = medianRun(hemY, 2);
  if (!hem) return { ok: false, error: "Could not read the hem.", mask };

  // Armpit: walk up from the hem; the body run widens sharply where sleeves join.
  const recent: number[] = [];
  let armpitY = -1;
  const startY = bottom - Math.round(shirtH * 0.05);
  const stopY = top + Math.round(shirtH * 0.1);
  for (let y = startY; y >= stopY; y--) {
    const run = runAt(y);
    if (!run) continue;
    const w = run[1] - run[0] + 1;
    if (recent.length >= 5) {
      const sorted = [...recent].sort((a, b) => a - b);
      const bodyW = sorted[sorted.length >> 1];
      if (w > bodyW * 1.2) {
        // Require it to stay wide for a few rows (ignore a single noisy row).
        let wide = 0;
        for (let k = 1; k <= 3; k++) {
          const r2 = runAt(y - k);
          if (r2 && r2[1] - r2[0] + 1 > bodyW * 1.2) wide++;
        }
        if (wide >= 2) {
          armpitY = y + 1;
          break;
        }
      }
    }
    recent.push(w);
    if (recent.length > 15) recent.shift();
  }
  if (armpitY < 0) {
    return { ok: false, error: "Could not find the armpits — lay the sleeves out flat, away from the body.", mask };
  }

  const chestY = Math.min(bottom, armpitY + Math.max(1, Math.round(2.54 * pxPerCm)));
  const chest = medianRun(chestY, 1);
  if (!chest) return { ok: false, error: "Could not read the chest.", mask };

  return {
    ok: true,
    mask,
    px: {
      chest: chest.w,
      length: shirtH + 1,
      hem: hem.w,
      armpitY,
      lines: {
        chest: { a: { x: chest.run[0], y: chestY }, b: { x: chest.run[1], y: chestY } },
        hem: { a: { x: hem.run[0], y: hemY }, b: { x: hem.run[1], y: hemY } },
        length: { a: { x: cx, y: top }, b: { x: cx, y: bottom } },
      },
    },
  };
}

export function measureShirt(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  pxPerCm: number,
  threshold = DEFAULT_THRESHOLD,
): MeasureResult {
  return measureMask(segmentShirt(rgba, width, height, threshold), pxPerCm);
}

// ── helpers ────────────────────────────────────────────────────────────────

type Plane = [number, number, number];

/**
 * Per-channel least-squares plane through the border ring. Refit once after
 * dropping the worst 20% of samples, so a sleeve or ruler touching the edge
 * doesn't drag the model.
 */
function fitBackground(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): [Plane, Plane, Plane] {
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  const step = Math.max(1, Math.round((w + h) / 800));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let d = 0; d < ring; d++) {
    for (let x = 0; x < w; x += step) {
      xs.push(x, x);
      ys.push(d, h - 1 - d);
    }
    for (let y = 0; y < h; y += step) {
      xs.push(d, w - 1 - d);
      ys.push(y, y);
    }
  }
  const val = (k: number, c: number) => rgba[(ys[k] * w + xs[k]) * 4 + c];
  const fit = (idx: number[]): [Plane, Plane, Plane] =>
    [0, 1, 2].map((c) => solvePlane(idx, xs, ys, (k) => val(k, c))) as [Plane, Plane, Plane];

  let idx = xs.map((_, k) => k);
  let planes = fit(idx);
  const resid = (k: number) => {
    let r = 0;
    for (let c = 0; c < 3; c++) {
      const [a, b, cc] = planes[c];
      const d = val(k, c) - (a + b * xs[k] + cc * ys[k]);
      r += d * d;
    }
    return r;
  };
  idx = idx
    .map((k) => ({ k, r: resid(k) }))
    .sort((p, q) => p.r - q.r)
    .slice(0, Math.max(3, Math.floor(idx.length * 0.8)))
    .map((e) => e.k);
  planes = fit(idx);
  return planes;
}

function solvePlane(idx: number[], xs: number[], ys: number[], v: (k: number) => number): Plane {
  // Normal equations for v ≈ a + b·x + c·y.
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sv = 0, sxv = 0, syv = 0;
  for (const k of idx) {
    const x = xs[k];
    const y = ys[k];
    const z = v(k);
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sv += z;
    sxv += x * z;
    syv += y * z;
  }
  const m = [
    [n, sx, sy, sv],
    [sx, sxx, sxy, sxv],
    [sy, sxy, syy, syv],
  ];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[piv][i])) piv = r;
    [m[i], m[piv]] = [m[piv], m[i]];
    if (Math.abs(m[i][i]) < 1e-9) return [n ? sv / n : 0, 0, 0];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** Square-window max filter (separable). */
function dilate(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morph(src, w, h, r, 1);
}
/** Square-window min filter (separable). */
function erode(src: Uint8Array, w: number, h: number, r: number): Uint8Array {
  return morph(src, w, h, r, 0);
}
function morph(src: Uint8Array, w: number, h: number, r: number, hit: 0 | 1): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const miss = hit ? 0 : 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = miss;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        if (src[row + k] === hit) {
          v = hit;
          break;
        }
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = miss;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        if (tmp[k * w + x] === hit) {
          v = hit;
          break;
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/**
 * The shape the operator pointed at, or the biggest one when they have not.
 *
 * "Biggest" is only a guess at which shape is the garment. A folded backdrop,
 * a shadow under the table edge or a second item in frame can all outrank it,
 * and then every measurement is of the wrong object. One tap settles it, so
 * the tap wins whenever there is one.
 */
function componentFor(src: Uint8Array, w: number, h: number, seed: Point | null): Uint8Array {
  if (seed) {
    const sx = Math.max(0, Math.min(w - 1, Math.round(seed.x)));
    const sy = Math.max(0, Math.min(h - 1, Math.round(seed.y)));
    // Search outward a little: a tap can land on a print or a seam that the
    // threshold dropped, and the operator means the garment around it.
    const maxR = Math.max(4, Math.round(Math.min(w, h) * 0.03));
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx, y = sy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (src[y * w + x]) return floodFrom(src, w, h, y * w + x);
        }
      }
    }
  }
  return largestComponent(src, w, h);
}

/** The connected shape containing one pixel. */
function floodFrom(src: Uint8Array, w: number, h: number, start: number): Uint8Array {
  const out = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  stack[sp++] = start;
  out[start] = 1;
  while (sp) {
    const p = stack[--sp];
    const x = p % w;
    const visit = (q: number) => {
      if (src[q] && !out[q]) { out[q] = 1; stack[sp++] = q; }
    };
    if (x > 0) visit(p - 1);
    if (x < w - 1) visit(p + 1);
    if (p >= w) visit(p - w);
    if (p < w * (h - 1)) visit(p + w);
  }
  return out;
}

function largestComponent(src: Uint8Array, w: number, h: number): Uint8Array {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let label = 0;
  for (let i = 0; i < w * h; i++) {
    if (!src[i] || labels[i]) continue;
    label++;
    let size = 0;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = label;
    while (sp) {
      const p = stack[--sp];
      size++;
      const visit = (q: number) => {
        if (src[q] && !labels[q]) {
          labels[q] = label;
          stack[sp++] = q;
        }
      };
      const x = p % w;
      if (x > 0) visit(p - 1);
      if (x < w - 1) visit(p + 1);
      if (p >= w) visit(p - w);
      if (p < w * (h - 1)) visit(p + w);
    }
    if (size > bestSize) {
      bestSize = size;
      best = label;
    }
  }
  const out = new Uint8Array(w * h);
  if (best) for (let i = 0; i < w * h; i++) out[i] = labels[i] === best ? 1 : 0;
  return out;
}

/** Background reachable from the border stays background; enclosed holes become shirt. */
function fillHoles(src: Uint8Array, w: number, h: number): Uint8Array {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const seed = (p: number) => {
    if (!src[p] && !outside[p]) {
      outside[p] = 1;
      stack[sp++] = p;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (sp) {
    const p = stack[--sp];
    const x = p % w;
    if (x > 0) seed(p - 1);
    if (x < w - 1) seed(p + 1);
    if (p >= w) seed(p - w);
    if (p < w * (h - 1)) seed(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

export function rowExtent(data: Uint8Array, w: number, y: number): [number, number] | null {
  const row = y * w;
  let l = -1;
  let r = -1;
  for (let x = 0; x < w; x++) {
    if (data[row + x]) {
      if (l < 0) l = x;
      r = x;
    }
  }
  return l < 0 ? null : [l, r];
}

/** The contiguous run of shirt pixels on row y containing (or nearest to) column cx. */
export function centerRun(data: Uint8Array, w: number, y: number, cx: number): [number, number] | null {
  const row = y * w;
  let x = cx;
  if (!data[row + x]) {
    let found = -1;
    for (let d = 1; d < w; d++) {
      if (x - d >= 0 && data[row + x - d]) {
        found = x - d;
        break;
      }
      if (x + d < w && data[row + x + d]) {
        found = x + d;
        break;
      }
    }
    if (found < 0) return null;
    x = found;
  }
  let l = x;
  let r = x;
  while (l > 0 && data[row + l - 1]) l--;
  while (r < w - 1 && data[row + r + 1]) r++;
  return [l, r];
}
