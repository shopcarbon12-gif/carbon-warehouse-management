import sharp from "sharp";

/**
 * The jeans label, placed from the operator's photo instead of drawn.
 *
 * Attached as a reference, the label still came back re-lettered ("CARRON
 * JEANS", "CARBON JEAN") and different in each pose: an image model redraws a
 * small patch, it does not copy it. So the renderer is told to leave a flat
 * key-colour shape where the label sits (Pose 7), and this module finds that
 * shape and paints the real photo into it — every letter is the photograph's.
 *
 * What the first real run taught (Julian Jeans, 2026-10-14): the renderer draws
 * a near-square, slightly uneven placeholder, not the label's shape. The label
 * was turned 15° inside it (an orientation read off the shape's moments) and
 * squeezed to its proportions. Now the label stays level unless the shape is
 * clearly tilted, keeps its own proportions (overhanging the placeholder a
 * little rather than squeezing), and nothing of the key colour survives.
 */

export type LabelKey = { name: string; hex: string; hi: number[]; lo: number[] };
export type LabelPhoto = { png: Buffer; width: number; height: number };

const MAGENTA: LabelKey = { name: "magenta", hex: "#FF00FF", hi: [0, 2], lo: [1] };
const GREEN: LabelKey = { name: "green", hex: "#00FF00", hi: [1], lo: [0, 2] };

/* Neon / shocking / fluorescent pink pass the magenta test, so any pink in the
   shoot moves the key to green. */
const MAGENTA_WORDS = /\b(magenta|fuchsia|fuschia|pink|purple|violet|plum|orchid|berry|mauve|lilac|lavender)\b/i;
const GREEN_WORDS = /\b(green|lime|olive|mint|emerald|chartreuse|sage|khaki)\b|\bneon[\s-]?(?:green|yellow)\b/i;

/** A key colour nothing in this shoot is meant to wear; null when neither is safe. */
export function pickLabelKey(shootText: string): LabelKey | null {
  if (!MAGENTA_WORDS.test(shootText)) return MAGENTA;
  if (!GREEN_WORDS.test(shootText)) return GREEN;
  return null;
}

/** "about 2.4 times as wide as it is tall" — the outline the renderer leaves. */
export function labelProportions(width: number, height: number): string {
  const r = width / Math.max(1, height);
  /* The renderer drew a near-square for "1.6 times as wide": a familiar
     object's shape lands better than a ratio alone. */
  if (r >= 1.4 && r <= 1.9) return `about ${r.toFixed(1)} times as wide as it is tall — the shape of a business card lying on its long side`;
  if (r >= 1.15) return `about ${r.toFixed(1)} times as wide as it is tall`;
  if (r <= 0.87) return `about ${(1 / r).toFixed(1)} times as tall as it is wide`;
  return "about as tall as it is wide";
}

/* ───────────────────────────── the label photo ───────────────────────────── */

/**
 * Upright label photo (EXIF applied), straightened when the crop still holds
 * denim around a slightly turned or keystoned patch: a level crop box around a
 * tilted label keeps blue wedges at its corners, and they pasted as a light
 * outline round the patch.
 */
export async function readLabelPhoto(bytes: Buffer): Promise<LabelPhoto> {
  const { data, info } = await sharp(bytes).autoOrient().flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
  const straight = straightenLabelCrop(data, info.width, info.height, info.channels);
  if (straight) {
    const png = await sharp(straight.data, { raw: { width: straight.width, height: straight.height, channels: 3 } }).png().toBuffer();
    return { png, width: straight.width, height: straight.height };
  }
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels as 3 } }).png().toBuffer();
  return { png, width: info.width, height: info.height };
}

/** Median colour of the middle of a crop — the patch itself. */
function patchColour(rgb: Buffer, ch: number, w: number, h: number): number[] {
  const vals: number[][] = [[], [], []];
  for (let y = Math.round(h * 0.2); y < h * 0.8; y += 3) {
    for (let x = Math.round(w * 0.2); x < w * 0.8; x += 3) {
      const i = (y * w + x) * ch;
      for (let c = 0; c < 3; c++) vals[c].push(rgb[i + c]);
    }
  }
  return vals.map((v) => (v.length ? v.sort((p, q) => p - q)[v.length >> 1] : 128));
}

/** A side of the crop: x = a·y + b for left/right, y = a·x + b for top/bottom. */
type SideLine = { a: number; b: number };

/**
 * The patch's own edge near one side of a crop, when the crop still holds a
 * strip of something else there (denim of any wash, a belt loop's shadow):
 * per scanline the strongest colour step within the outer 9%, a straight line
 * through the steps that agree, kept only when what lies outside it clearly
 * differs from the patch just inside it. null = the crop is already tight.
 */
export function findSide(
  lum: Float32Array,
  rgb: Buffer,
  ch: number,
  w: number,
  h: number,
  side: "left" | "right" | "top" | "bottom",
): SideLine | null {
  const vertical = side === "left" || side === "right";
  const len = vertical ? h : w; // scanlines run along this
  const span = vertical ? w : h; // and look inward across this
  const maxDepth = Math.max(4, Math.round(span * 0.09));
  const at = (along: number, depth: number) => {
    const across = side === "left" || side === "top" ? depth : span - 1 - depth;
    return vertical ? along * w + across : across * w + along;
  };
  const pts: Array<[number, number]> = [];
  for (let t = Math.round(len * 0.06); t < len * 0.94; t += 2) {
    let best = 0;
    let bestD = -1;
    for (let d = 2; d < maxDepth; d++) {
      const out = (lum[at(t, d - 2)] + lum[at(t, d - 1)]) / 2;
      const inn = (lum[at(t, d + 1)] + lum[at(t, d + 2)]) / 2;
      const g = Math.abs(inn - out);
      if (g > best) {
        best = g;
        bestD = d;
      }
    }
    if (best >= 22 && bestD > 0) pts.push([t, bestD]);
  }
  const scans = Math.max(1, Math.floor((len * 0.88) / 2));
  if (pts.length < scans * 0.5) return null;
  /* A strip runs the whole side: the steps must reach both ends of it. A line
     of print near the edge ("CARBON JEANS" above the bottom seam) does not. */
  const endZone = (lo: number, hi: number) => {
    const inZone = pts.filter(([t]) => t >= len * lo && t < len * hi).length;
    return inZone / Math.max(1, (len * (hi - lo)) / 2);
  };
  if (endZone(0.06, 0.18) < 0.5 || endZone(0.82, 0.94) < 0.5) return null;
  /* A real strip's edge moves smoothly from one scanline to the next; steps
     that jump about are the patch's own print, not its edge. */
  let smooth = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i][0] - pts[i - 1][0] <= 4 && Math.abs(pts[i][1] - pts[i - 1][1]) <= 3) smooth++;
  if (smooth < (pts.length - 1) * 0.7) return null;
  /* Median-smoothed profile, a straight line through it, then moved inward
     until the profile is outside it almost everywhere: a slightly curved or
     wavy patch edge loses a sliver of patch rather than keeping a sliver of
     cloth. */
  const med = pts.map((_, i) => {
    const win = pts.slice(Math.max(0, i - 3), i + 4).map((q) => q[1]).sort((x, y) => x - y);
    return [pts[i][0], win[win.length >> 1]] as [number, number];
  });
  let st = 0, sd = 0, stt = 0, std = 0;
  for (const [t, d] of med) { st += t; sd += d; stt += t * t; std += t * d; }
  const k = med.length;
  const den = k * stt - st * st;
  const a = den ? (k * std - st * sd) / den : 0;
  if (Math.abs(a) > 0.12) return null;
  const res = med.map(([t, d]) => d - (a * t + sd / k - a * st / k)).sort((x, y) => x - y);
  const b = sd / k - a * (st / k) + Math.max(0, res[Math.floor(res.length * 0.95)]) + 1;
  const dMax = Math.max(b, a * (len - 1) + b);
  if (dMax < 3 || dMax > maxDepth) return null;
  /* What is outside the line must clearly differ from the patch just inside it
     — otherwise this is the patch's own stitching or print, not a strip. */
  let os = [0, 0, 0], is = [0, 0, 0], on = 0, inN = 0;
  for (let t = Math.round(len * 0.1); t < len * 0.9; t += 3) {
    const d = a * t + b;
    for (let dd = 0; dd < d - 1; dd++) {
      const i = at(t, dd) * ch;
      for (let c = 0; c < 3; c++) os[c] += rgb[i + c];
      on++;
    }
    for (let dd = Math.ceil(d + 2); dd < d + 2 + Math.max(3, d); dd++) {
      const i = at(t, Math.min(span - 1, dd)) * ch;
      for (let c = 0; c < 3; c++) is[c] += rgb[i + c];
      inN++;
    }
  }
  if (!on || !inN) return null;
  os = os.map((v) => v / on);
  is = is.map((v) => v / inN);
  const diff = Math.hypot(os[0] - is[0], os[1] - is[1], os[2] - is[2]);
  if (diff < 40) return null;
  /* …and unlike the patch as a whole: the label's own border or seam is not a strip. */
  const body = patchColour(rgb, ch, w, h);
  if (Math.hypot(os[0] - body[0], os[1] - body[1], os[2] - body[2]) < 35) return null;
  /* Convert depth-from-side into a crop coordinate. */
  return side === "left" || side === "top" ? { a, b: b + 1 } : { a: -a, b: span - 1 - b - 1 };
}

/**
 * The patch inside a crop that still shows a strip of cloth along one or more
 * sides — a level crop box round a slightly turned or keystoned label keeps
 * wedges of denim, which pasted as a light outline round the patch. Each such
 * side is cut along the patch's own edge and the patch is warped flat. null
 * when every side is already tight.
 */
export function straightenLabelCrop(
  data: Buffer,
  w: number,
  h: number,
  ch: number,
): { data: Buffer; width: number; height: number } | null {
  if (w < 24 || h < 16) return null;
  const lum = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) lum[p] = 0.299 * data[p * ch] + 0.587 * data[p * ch + 1] + 0.114 * data[p * ch + 2];
  const left = findSide(lum, data, ch, w, h, "left");
  const right = findSide(lum, data, ch, w, h, "right");
  const topL = findSide(lum, data, ch, w, h, "top");
  const bottom = findSide(lum, data, ch, w, h, "bottom");
  if (!left && !right && !topL && !bottom) return straightenByDenimCorners(data, w, h, ch);
  const L: SideLine = left ?? { a: 0, b: 0 };
  const R: SideLine = right ?? { a: 0, b: w - 1 };
  const T: SideLine = topL ?? { a: 0, b: 0 };
  const B: SideLine = bottom ?? { a: 0, b: h - 1 };
  /* Corners: x = aV·y + bV meets y = aH·x + bH. */
  const meet = (v: SideLine, hz: SideLine) => {
    const y = (hz.a * v.b + hz.b) / (1 - hz.a * v.a);
    return [v.a * y + v.b, y];
  };
  return warpQuad(data, w, h, ch, [meet(L, T), meet(R, T), meet(R, B), meet(L, B)], 0);
}

/** Clearly blue cloth (light or dark denim), not a black / white / grey / yellow patch. */
function isDenim(d: Buffer, i: number) {
  const r = d[i];
  const g = d[i + 1];
  const b = d[i + 2];
  return b >= 60 && b >= r + 14 && b >= g + 4;
}

/**
 * The fallback for a wedge of blue denim in one corner only (too short for a
 * side line): the denim reachable from the border is cut away, the patch's
 * four corners are its extreme points along the diagonals, and it is warped
 * flat. Thin border wedges only — blue deeper in is the label's own print.
 */
function straightenByDenimCorners(data: Buffer, w: number, h: number, ch: number): { data: Buffer; width: number; height: number } | null {
  const n = w * h;
  const cloth = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const seed = (x: number, y: number) => {
    const k = y * w + x;
    if (cloth[k] || !isDenim(data, k * ch)) return;
    cloth[k] = 1;
    stack[top++] = k;
  };
  for (let x = 0; x < w; x++) { seed(x, 0); seed(x, h - 1); }
  for (let y = 0; y < h; y++) { seed(0, y); seed(w - 1, y); }
  let count = 0;
  let deepest = 0;
  while (top) {
    const k = stack[--top];
    count++;
    const x = k % w;
    const y = (k / w) | 0;
    deepest = Math.max(deepest, Math.min(x / w, (w - 1 - x) / w, y / h, (h - 1 - y) / h));
    if (x > 0) seed(x - 1, y);
    if (x < w - 1) seed(x + 1, y);
    if (y > 0) seed(x, y - 1);
    if (y < h - 1) seed(x, y + 1);
  }
  if (count < n * 0.003 || count > n * 0.22 || deepest > 0.09) return null;
  let tl = [0, 0], tr = [0, 0], br = [0, 0], bl = [0, 0];
  let sMin = Infinity, sMax = -Infinity, dMin = Infinity, dMax = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cloth[y * w + x]) continue;
      const s = x + y;
      const d = x - y;
      if (s < sMin) { sMin = s; tl = [x, y]; }
      if (s > sMax) { sMax = s; br = [x, y]; }
      if (d > dMax) { dMax = d; tr = [x, y]; }
      if (d < dMin) { dMin = d; bl = [x, y]; }
    }
  }
  return warpQuad(data, w, h, ch, [tl, tr, br, bl], 0.01);
}

/** The quad (tl, tr, br, bl) warped flat, each corner pulled `inset` toward the centre. */
function warpQuad(data: Buffer, w: number, h: number, ch: number, quad: number[][], inset: number): { data: Buffer; width: number; height: number } | null {
  const cxq = quad.reduce((a, p) => a + p[0], 0) / 4;
  const cyq = quad.reduce((a, p) => a + p[1], 0) / 4;
  const [tl, tr, br, bl] = quad.map(([x, y]) => [x + (cxq - x) * inset, y + (cyq - y) * inset]);
  const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  const W = Math.round((dist(tl, tr) + dist(bl, br)) / 2);
  const H = Math.round((dist(tl, bl) + dist(tr, br)) / 2);
  if (W < 0.8 * w || H < 0.8 * h || W > 1.05 * w || H > 1.05 * h) return null;
  const hm = homography([tl, tr, br, bl], [[0, 0], [W, 0], [W, H], [0, H]]);
  const out = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const z = hm[6] * (x + 0.5) + hm[7] * (y + 0.5) + 1;
      const u = (hm[0] * (x + 0.5) + hm[1] * (y + 0.5) + hm[2]) / z - 0.5;
      const v = (hm[3] * (x + 0.5) + hm[4] * (y + 0.5) + hm[5]) / z - 0.5;
      const x0 = Math.max(0, Math.min(w - 2, Math.floor(u)));
      const y0 = Math.max(0, Math.min(h - 2, Math.floor(v)));
      const tx = Math.min(1, Math.max(0, u - x0));
      const ty = Math.min(1, Math.max(0, v - y0));
      for (let c = 0; c < 3; c++) {
        const p = (yy: number, xx: number) => data[(yy * w + xx) * ch + c];
        out[(y * W + x) * 3 + c] = Math.round(
          (p(y0, x0) * (1 - tx) + p(y0, x0 + 1) * tx) * (1 - ty) + (p(y0 + 1, x0) * (1 - tx) + p(y0 + 1, x0 + 1) * tx) * ty,
        );
      }
    }
  }
  return { data: out, width: W, height: H };
}

/** 3×3 homography (8 values, h33 = 1) mapping dst points → src points. */
function homography(srcPts: number[][], dstPts: number[][]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dstPts[i];
    const [u, v] = srcPts[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const M = A.map((r, i) => [...r, b[i]]);
  const N = 8;
  for (let c = 0; c < N; c++) {
    let p = c;
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < N; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= N; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[N] / r[i]);
}

/* ───────────────────────────── the placeholder ───────────────────────────── */

/** How far the label may be squeezed or stretched to meet the placeholder. */
const MAX_SQUASH = 1.06;
/** How far past the placeholder the label may reach (each side, of its size)
 *  before any of the placeholder is filled with cloth instead. */
const MAX_OVERHANG = 0.18;
/** A label on a back waistband sits near level; no wider search than this. */
const MAX_TILT = (25 * Math.PI) / 180;

/**
 * The angle of the smallest box around a shape (edge points as x,y pairs about
 * its centre), searched within ±MAX_TILT of level in half-degree steps. Angles
 * whose box is within 3% of the smallest count as ties and the most level one
 * wins — a placeholder drawn slightly uneven is not a tilted label.
 */
export function levelMinAreaAngle(edge: number[]): number {
  if (edge.length < 4) return 0;
  const step = Math.PI / 360;
  const areas: Array<[number, number]> = [];
  let best = Infinity;
  const steps = Math.round(MAX_TILT / step);
  for (let i = -steps; i <= steps; i++) {
    const t = i * step;
    const c = Math.cos(t);
    const s = Math.sin(t);
    let amin = Infinity;
    let amax = -Infinity;
    let bmin = Infinity;
    let bmax = -Infinity;
    for (let e = 0; e < edge.length; e += 2) {
      const a = edge[e] * c + edge[e + 1] * s;
      const b = -edge[e] * s + edge[e + 1] * c;
      if (a < amin) amin = a;
      if (a > amax) amax = a;
      if (b < bmin) bmin = b;
      if (b > bmax) bmax = b;
    }
    const area = (amax - amin + 1) * (bmax - bmin + 1);
    areas.push([t, area]);
    if (area < best) best = area;
  }
  let pick = 0;
  let pickAbs = Infinity;
  for (const [t, area] of areas) {
    if (area <= best * 1.03 && Math.abs(t) < pickAbs) {
      pick = t;
      pickAbs = Math.abs(t);
    }
  }
  return pick;
}

/** A binary mask grown (dilate) or shrunk (erode) by r pixels, square neighbourhood. */
function morph(mask: Uint8Array, w: number, h: number, r: number, grow: boolean): Uint8Array {
  const want = grow ? 1 : 0;
  const pass = (src: Uint8Array, horizontal: boolean) => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let hit = 0;
        for (let d = -r; d <= r && !hit; d++) {
          const xx = horizontal ? x + d : x;
          const yy = horizontal ? y : y + d;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
            if (!grow) hit = 1;
            continue;
          }
          if (src[yy * w + xx] === want) hit = 1;
        }
        out[y * w + x] = grow ? hit : hit ? 0 : 1;
      }
    }
    return out;
  };
  return pass(pass(mask, true), false);
}

/** Box-blurred values over box-blurred weights (a blur that ignores weight-0
 *  pixels); 0 where no weighted pixel is within reach. */
function boxBlurRatio(val: Float32Array, wt: Float32Array, w: number, h: number, r: number): Float32Array {
  const blur = (src: Float32Array) => {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x < w; x++) {
        if (x + r < w) acc += src[y * w + x + r];
        if (x - r - 1 >= 0) acc -= src[y * w + x - r - 1];
        if (x >= 0) tmp[y * w + x] = acc;
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y < h; y++) {
        if (y + r < h) acc += tmp[(y + r) * w + x];
        if (y - r - 1 >= 0) acc -= tmp[(y - r - 1) * w + x];
        if (y >= 0) out[y * w + x] = acc;
      }
    }
    return out;
  };
  const bv = blur(val);
  const bwt = blur(wt);
  const out = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) out[k] = bwt[k] > 0.5 ? bv[k] / bwt[k] : 0;
  return out;
}

function keyScores(d: Buffer, i: number, key: LabelKey) {
  let hiMin = 255;
  let hiMax = 0;
  let loMax = 0;
  for (const c of key.hi) {
    const v = d[i + c];
    if (v < hiMin) hiMin = v;
    if (v > hiMax) hiMax = v;
  }
  for (const c of key.lo) if (d[i + c] > loMax) loMax = d[i + c];
  return { hiMin, hiMax, loMax };
}

function isCore(d: Buffer, i: number, key: LabelKey) {
  const { hiMin, hiMax, loMax } = keyScores(d, i, key);
  return hiMin >= 60 && loMax <= 0.45 * hiMin && hiMax - hiMin <= 0.3 * hiMax;
}

/** Faintly tinted: a soft edge, a sheen, a fade into the hem. */
function isTinted(d: Buffer, i: number, key: LabelKey) {
  const { hiMin, hiMax, loMax } = keyScores(d, i, key);
  return hiMin - loMax >= 14 && hiMax - hiMin <= 0.5 * Math.max(1, hiMax);
}

export type LabelCompositeResult = {
  b64: string;
  /** 1 when the label was painted into a placeholder, 0 when none was usable. */
  placed: number;
  /** Key-colour pixels still around the placeholder afterwards (0 = clean). */
  keyPixelsLeft: number;
  /** Other drawn placeholders in the searched area, painted out as cloth. */
  strayShapes: number;
  /** Share of the placeholder that became cloth instead of label (0..1). */
  clothShare: number;
  /** Key-colour pixels found in the searched area before anything was painted. */
  keySeen: number;
};

type Fit = {
  ids: number[];
  x0: number;
  y0: number;
  bw: number;
  bh: number;
  filled: Uint8Array;
  outside: Uint8Array;
  fillArea: number;
  cx: number;
  cy: number;
  c: number;
  sn: number;
  sL: number;
  sR: number;
  sT: number;
  sB: number;
  solidity: number;
  aspect: number;
};

/**
 * Finds the flat key-colour placeholder in the given part of the render and
 * paints the label photo into it: level with the shape unless it is clearly
 * tilted, reading left to right, in the label's own proportions (reaching a
 * little past the placeholder rather than squeezing), lit by the shape's own
 * broad shading, edges anti-aliased. Only ONE label is ever placed; any other
 * key-colour bits there are painted out as cloth, so no magenta survives.
 */
export async function compositeLabelIntoKey(args: {
  imageB64: string;
  label: LabelPhoto;
  key: LabelKey;
  /** The part of the width to search, as fractions (the Pose 7 half). */
  region?: { x0: number; x1: number };
}): Promise<LabelCompositeResult> {
  const input = Buffer.from(args.imageB64, "base64");
  const meta = await sharp(input).metadata();
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const n = w * h;
  const key = args.key;
  const rx0 = Math.max(0, Math.floor((args.region?.x0 ?? 0) * w));
  const rx1 = Math.min(w - 1, Math.ceil((args.region?.x1 ?? 1) * w) - 1);
  const inRegion = (x: number) => x >= rx0 && x <= rx1;

  const core = new Uint8Array(n);
  let coreCount = 0;
  for (let y = 0; y < h; y++) {
    for (let x = rx0; x <= rx1; x++) {
      const p = y * w + x;
      if (isCore(data, p * ch, key)) {
        core[p] = 1;
        coreCount++;
      }
    }
  }
  if (!coreCount) return { b64: args.imageB64, placed: 0, keyPixelsLeft: 0, strayShapes: 0, clothShare: 0, keySeen: 0 };

  /* Close small gaps first: a seam line, a stitch row or a thread drawn across
     the placeholder must not split it into two labels. */
  const closed = morph(morph(core, w, h, 3, true), w, h, 3, false);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!inRegion(x)) closed[y * w + x] = 0;

  const comp = new Int32Array(n);
  const stack = new Int32Array(n);
  const blobs: Array<{ id: number; x0: number; y0: number; x1: number; y1: number; area: number }> = [];
  let nextId = 0;
  for (let p = 0; p < n; p++) {
    if (!closed[p] || comp[p]) continue;
    const id = ++nextId;
    let top = 0;
    stack[top++] = p;
    comp[p] = id;
    let area = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (top) {
      const q = stack[--top];
      area++;
      const x = q % w;
      const y = (q / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && closed[q - 1] && !comp[q - 1]) { comp[q - 1] = id; stack[top++] = q - 1; }
      if (x < w - 1 && closed[q + 1] && !comp[q + 1]) { comp[q + 1] = id; stack[top++] = q + 1; }
      if (y > 0 && closed[q - w] && !comp[q - w]) { comp[q - w] = id; stack[top++] = q - w; }
      if (y < h - 1 && closed[q + w] && !comp[q + w]) { comp[q + w] = id; stack[top++] = q + w; }
    }
    blobs.push({ id, x0, y0, x1, y1, area });
  }

  /* A label is a small patch: specks and anything the size of a garment are not it. */
  const minArea = Math.max(80, Math.round(n * 0.00005));
  const maxArea = Math.round(n * 0.04);
  type Blob = (typeof blobs)[number];
  const fitBlob = (parts: Blob[]): Fit => {
    const pad = 3;
    const ids = parts.map((p) => p.id);
    const idSet = new Set(ids);
    const x0 = Math.max(0, Math.min(...parts.map((p) => p.x0)) - pad);
    const y0 = Math.max(0, Math.min(...parts.map((p) => p.y0)) - pad);
    const bw = Math.min(w - 1, Math.max(...parts.map((p) => p.x1)) + pad) - x0 + 1;
    const bh = Math.min(h - 1, Math.max(...parts.map((p) => p.y1)) + pad) - y0 + 1;
    const inShape = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (idSet.has(comp[(y0 + y) * w + x0 + x])) inShape[y * bw + x] = 1;
    /* Holes (lettering the renderer drew on the placeholder anyway) belong to it. */
    const outside = new Uint8Array(bw * bh);
    let top = 0;
    const seed = (lx: number, ly: number) => {
      const k = ly * bw + lx;
      if (!inShape[k] && !outside[k]) { outside[k] = 1; stack[top++] = k; }
    };
    for (let x = 0; x < bw; x++) { seed(x, 0); seed(x, bh - 1); }
    for (let y = 0; y < bh; y++) { seed(0, y); seed(bw - 1, y); }
    while (top) {
      const k = stack[--top];
      const x = k % bw;
      const y = (k / bw) | 0;
      if (x > 0) seed(x - 1, y);
      if (x < bw - 1) seed(x + 1, y);
      if (y > 0) seed(x, y - 1);
      if (y < bh - 1) seed(x, y + 1);
    }
    const filled = new Uint8Array(bw * bh);
    let fillArea = 0;
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < bw * bh; k++) {
      if (outside[k]) continue;
      filled[k] = 1;
      fillArea++;
      sx += k % bw;
      sy += (k / bw) | 0;
    }
    const cx = sx / Math.max(1, fillArea);
    const cy = sy / Math.max(1, fillArea);
    const edge: number[] = [];
    for (let k = 0; k < bw * bh; k++) {
      if (!filled[k]) continue;
      const x = k % bw;
      const y = (k / bw) | 0;
      if (x === 0 || y === 0 || x === bw - 1 || y === bh - 1 || !filled[k - 1] || !filled[k + 1] || !filled[k - bw] || !filled[k + bw]) {
        edge.push(x - cx, y - cy);
      }
    }
    const theta = levelMinAreaAngle(edge);
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    let amin = Infinity;
    let amax = -Infinity;
    let bmin = Infinity;
    let bmax = -Infinity;
    for (let e = 0; e < edge.length; e += 2) {
      const a = edge[e] * c + edge[e + 1] * sn;
      const b = -edge[e] * sn + edge[e + 1] * c;
      if (a < amin) amin = a;
      if (a > amax) amax = a;
      if (b < bmin) bmin = b;
      if (b > bmax) bmax = b;
    }
    const sL = amin - 0.5;
    const sR = amax + 0.5;
    const sT = bmin - 0.5;
    const sB = bmax + 0.5;
    return {
      ids, x0, y0, bw, bh, filled, outside, fillArea, cx, cy, c, sn, sL, sR, sT, sB,
      solidity: fillArea / Math.max(1, (sR - sL) * (sB - sT)),
      aspect: (sR - sL) / Math.max(1, sB - sT),
    };
  };

  /* ONE placeholder: the most patch-like candidate (solid, four-sided, a
     plausible label shape), else the biggest one so no magenta block survives. */
  const sized = blobs.filter((b) => b.area >= minArea && b.area <= maxArea);
  const fits = sized.map((b) => fitBlob([b]));
  let chosen: Fit | null = null;
  let bestScore = -1;
  for (const f of fits) {
    if (f.solidity < 0.45 || f.aspect < 0.35 || f.aspect > 4) continue;
    const score = f.fillArea * f.solidity;
    if (score > bestScore) {
      bestScore = score;
      chosen = f;
    }
  }
  if (!chosen && fits.length) chosen = fits.reduce((a, b) => (b.fillArea > a.fillArea ? b : a));

  /* A placeholder the renderer drew behind a belt loop (or a finger, a fold)
     comes out in pieces side by side: they are one label, and the loop stays
     in front of it. Pieces join when the gap is narrow and they share a height. */
  if (chosen) {
    let parts = blobs.filter((b) => chosen!.ids.includes(b.id));
    for (let grew = true; grew; ) {
      grew = false;
      const ux0 = Math.min(...parts.map((p) => p.x0));
      const ux1 = Math.max(...parts.map((p) => p.x1));
      const uy0 = Math.min(...parts.map((p) => p.y0));
      const uy1 = Math.max(...parts.map((p) => p.y1));
      for (const b of blobs) {
        if (parts.includes(b) || b.area < minArea / 4) continue;
        const gap = b.x0 > ux1 ? b.x0 - ux1 : ux0 > b.x1 ? ux0 - b.x1 : 0;
        const overlap = Math.min(uy1, b.y1) - Math.max(uy0, b.y0);
        const minH = Math.min(uy1 - uy0, b.y1 - b.y0);
        const together = Math.max(ux1, b.x1) - Math.min(ux0, b.x0);
        if (gap > 0 && gap <= Math.max(12, 0.3 * together) && overlap >= 0.6 * minH) {
          parts = [...parts, b];
          grew = true;
        }
      }
    }
    if (parts.length > 1) chosen = fitBlob(parts);
  }

  const out = Buffer.from(data);
  let clothShare = 0;
  if (chosen) clothShare = await paintLabel(chosen);

  /* Key colour left around the placeholder (a soft halo, a bit cut off by a
     belt loop) and any second drawn placeholder is painted out as the cloth
     around it. Elsewhere it is left alone: a purple print on the shirt is the
     outfit, not a placeholder. */
  const zones: Array<[number, number, number, number]> = [];
  if (chosen) {
    const m = Math.max(12, Math.round(Math.max(chosen.bw, chosen.bh) * 0.5));
    zones.push([chosen.x0 - m, chosen.y0 - m, chosen.x0 + chosen.bw + m, chosen.y0 + chosen.bh + m]);
  }
  let strayShapes = 0;
  for (const f of fits) {
    if ((chosen && f.ids.some((id) => chosen!.ids.includes(id))) || f.solidity < 0.6 || f.aspect < 0.35 || f.aspect > 4) continue;
    zones.push([f.x0 - 4, f.y0 - 4, f.x0 + f.bw + 4, f.y0 + f.bh + 4]);
    strayShapes++;
  }
  if (zones.length) cleanResidue(zones);

  let keyPixelsLeft = 0;
  for (const [a, b, c2, d] of zones) {
    for (let y = Math.max(0, b); y <= Math.min(h - 1, d); y++) {
      for (let x = Math.max(rx0, a); x <= Math.min(rx1, c2); x++) if (isCore(out, (y * w + x) * ch, key)) keyPixelsLeft++;
    }
  }

  const img = sharp(out, { raw: { width: w, height: h, channels: ch as 3 } });
  const encoded =
    meta.format === "jpeg"
      ? await img.jpeg({ quality: 95 }).toBuffer()
      : meta.format === "webp"
        ? await img.webp({ quality: 95 }).toBuffer()
        : await img.png().toBuffer();
  return { b64: encoded.toString("base64"), placed: chosen ? 1 : 0, keyPixelsLeft, strayShapes, clothShare, keySeen: coreCount };

  /* ── helpers that read the closure ── */

  async function paintLabel(f: Fit): Promise<number> {
    const { x0, y0, bw, bh, filled, outside, cx, cy, c, sn, sL, sR, sT, sB } = f;
    const rw = sR - sL;
    const rh = sB - sT;
    const labelAspect = args.label.width / Math.max(1, args.label.height);
    const shapeAspect = rw / rh;
    const aspect = Math.min(labelAspect * MAX_SQUASH, Math.max(labelAspect / MAX_SQUASH, shapeAspect));
    /* The label rect in the shape's axes. Too tall a placeholder: the label
       takes its full height and reaches past its sides (up to MAX_OVERHANG
       each); too wide: its full width, reaching below it. Always from the top
       — a label is sewn at the top of the waistband. */
    let L = sL;
    let R = sR;
    const T = sT;
    let B = sB;
    if (aspect > shapeAspect) {
      const want = rh * aspect;
      const lw = Math.min(want, rw * (1 + 2 * MAX_OVERHANG));
      const mid = (sL + sR) / 2;
      L = mid - lw / 2;
      R = mid + lw / 2;
      B = sT + lw / aspect;
    } else if (aspect < shapeAspect) {
      const want = rw / aspect;
      const lh = Math.min(want, rh * (1 + MAX_OVERHANG));
      B = sT + lh;
      const lw = lh * aspect;
      const mid = (sL + sR) / 2;
      L = mid - lw / 2;
      R = mid + lw / 2;
    }
    const lw = Math.max(2, Math.round(R - L));
    const lh = Math.max(2, Math.round(B - T));
    const lab = await sharp(args.label.png).resize(lw, lh, { fit: "fill" }).ensureAlpha().raw().toBuffer();

    const toLocal = (x: number, y: number) => {
      const dx = x - x0 - cx;
      const dy = y - y0 - cy;
      return [dx * c + dy * sn, -dx * sn + dy * c];
    };
    const toImage = (u: number, v: number) => [cx + x0 + u * c - v * sn, cy + y0 + u * sn + v * c];

    /* What occludes the placeholder from above (the shirt hem) stays in front:
       per column of the label, nothing is painted above the shape's own top. */
    const colTop = new Map<number, number>();
    const colCount = new Map<number, number>();
    for (let k = 0; k < bw * bh; k++) {
      if (!filled[k]) continue;
      const [u, v] = toLocal(x0 + (k % bw), y0 + ((k / bw) | 0));
      const cu = Math.round(u);
      const prev = colTop.get(cu);
      if (prev === undefined || v < prev) colTop.set(cu, v);
      colCount.set(cu, (colCount.get(cu) ?? 0) + 1);
    }
    /* Only columns that cross most of the shape say where its top is: the thin
       outermost columns of a tilted or rounded shape start low, and borrowing
       their top cut a notch out of the label's corner. */
    const maxCount = Math.max(1, ...colCount.values());
    const fullCols = [...colCount.entries()].filter(([, cnt]) => cnt >= 0.6 * maxCount).map(([cu]) => cu).sort((a, b) => a - b);
    const uFullMin = fullCols.length ? fullCols[0] : 0;
    const uFullMax = fullCols.length ? fullCols[fullCols.length - 1] : -1;
    const fullSet = new Set(fullCols);
    /* Columns inside the shape's span with almost none of it are something in
       front of the placeholder (a belt loop between two pieces): kept. */
    const gapCol = (u: number) => {
      const cu = Math.round(u);
      if (cu <= uFullMin || cu >= uFullMax) return false;
      return (colCount.get(cu) ?? 0) < 0.3 * maxCount;
    };
    const topAt = (u: number) => {
      const cu = Math.round(u);
      if (cu < uFullMin || cu > uFullMax) return -Infinity; // beside the shape: nothing in front
      for (let d = 0; d < 6; d++) {
        if (fullSet.has(cu - d)) return colTop.get(cu - d) ?? -Infinity;
        if (fullSet.has(cu + d)) return colTop.get(cu + d) ?? -Infinity;
      }
      return -Infinity;
    };

    /* Only a real dip in the shape's top is something in front of it (a hem
       hanging over the patch); a degree or two of tilt, or the label reaching
       past a placeholder's side, is not — the label's corner stays. */
    const occludeTol = Math.max(2, 0.12 * rh);

    /* The cloth around the shape, for any transparent part of the label photo. */
    const ring: number[][] = [[], [], []];
    for (let k = 0; k < bw * bh; k++) {
      if (!outside[k]) continue;
      const i = ((y0 + ((k / bw) | 0)) * w + x0 + (k % bw)) * ch;
      if (isTinted(data, i, key)) continue;
      for (let j = 0; j < 3; j++) ring[j].push(data[i + j]);
    }
    const median = (v: number[]) => (v.length ? v.sort((p, q) => p - q)[v.length >> 1] : 128);
    const bg = [median(ring[0]), median(ring[1]), median(ring[2])];

    /* The renderer's own light on the shape — only its broad fall-off, blurred
       well past letter size, so lettering drawn on the placeholder does not
       print through as a shadow. */
    const lumSum = new Float32Array(bw * bh);
    const lumW = new Float32Array(bw * bh);
    const lums: number[] = [];
    for (let k = 0; k < bw * bh; k++) {
      if (!filled[k]) continue;
      const i = ((y0 + ((k / bw) | 0)) * w + x0 + (k % bw)) * ch;
      if (!isCore(data, i, key)) continue;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      lumSum[k] = lum;
      lumW[k] = 1;
      lums.push(lum);
    }
    const refLum = Math.max(1, median(lums));
    const light = boxBlurRatio(lumSum, lumW, bw, bh, Math.max(2, Math.round(Math.min(bw, bh) / 5)));
    const lightAt = (x: number, y: number) => {
      const lx = Math.round(x) - x0;
      const ly = Math.round(y) - y0;
      if (lx < 0 || ly < 0 || lx >= bw || ly >= bh) return 1;
      const l = light[ly * bw + lx];
      return l > 0 ? 1 + 0.7 * (Math.min(1.2, Math.max(0.6, l / refLum)) - 1) : 1;
    };

    const sampleLabel = (fx: number, fy: number, out4: number[]) => {
      const x = Math.min(lw - 1, Math.max(0, fx));
      const y = Math.min(lh - 1, Math.max(0, fy));
      const xa = Math.floor(x);
      const ya = Math.floor(y);
      const xb = Math.min(lw - 1, xa + 1);
      const yb = Math.min(lh - 1, ya + 1);
      const tx = x - xa;
      const ty = y - ya;
      for (let j = 0; j < 4; j++) {
        const a = lab[(ya * lw + xa) * 4 + j] * (1 - tx) + lab[(ya * lw + xb) * 4 + j] * tx;
        const b = lab[(yb * lw + xa) * 4 + j] * (1 - tx) + lab[(yb * lw + xb) * 4 + j] * tx;
        out4[j] = a * (1 - ty) + b * ty;
      }
    };
    /* Original pixel at an image point if it is cloth (not key-tinted). */
    const clothAt = (x: number, y: number, out3: number[]): boolean => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return false;
      const i = (yi * w + xi) * ch;
      if (isTinted(data, i, key)) return false;
      out3[0] = data[i];
      out3[1] = data[i + 1];
      out3[2] = data[i + 2];
      return true;
    };
    const tmpA = [0, 0, 0];
    const tmpB = [0, 0, 0];
    /* Cloth for the part of the placeholder the label does not cover. Below
       the label: the cloth at the same height left and right of the shape
       (so horizontal seams carry straight across), weighted by distance,
       turning into the cloth just below the shape near its bottom edge. Beside
       the label: the cloth just past that side. */
    const clothFill = (u: number, v: number, out3: number[]) => {
      const stepOut = (u0: number, v0: number, du: number, dv: number, o: number[]) => {
        for (let s = 0; s < 14; s++) {
          const [x, y] = toImage(u0 + du * s * 2, v0 + dv * s * 2);
          if (clothAt(x, y, o)) return true;
        }
        return false;
      };
      if (v > B && u >= L && u <= R) {
        const span = sR - sL;
        const okL = stepOut(sL - 3 - (u - sL) * 0.25 - span * 0.1, v, -1, 0, tmpA);
        const okR = stepOut(sR + 3 + (sR - u) * 0.25 + span * 0.1, v, 1, 0, tmpB);
        const t = Math.min(1, Math.max(0, (u - sL) / Math.max(1, span)));
        for (let j = 0; j < 3; j++) {
          out3[j] = okL && okR ? tmpA[j] * (1 - t) + tmpB[j] * t : okL ? tmpA[j] : okR ? tmpB[j] : bg[j];
        }
        const toEdge = sB - v;
        if (toEdge < 6 && stepOut(u, sB + 2 + (sB - v), 0, 1, tmpA)) {
          const m = 1 - Math.max(0, toEdge) / 6;
          for (let j = 0; j < 3; j++) out3[j] = out3[j] * (1 - m) + tmpA[j] * m;
        }
        return;
      }
      if (u < L) {
        if (stepOut(u - (L - sL) - 3, v, -1, 0, out3)) return;
      } else if (u > R) {
        if (stepOut(u + (sR - R) + 3, v, 1, 0, out3)) return;
      } else if (v < T) {
        if (stepOut(u, v - 3, 0, -1, out3)) return;
      } else if (stepOut(u, sB + 3, 0, 1, out3)) return;
      out3[0] = bg[0];
      out3[1] = bg[1];
      out3[2] = bg[2];
    };

    /* Paint: the label rect (anti-aliased at its edges) wherever it is not
       above the shape's own top; the rest of the shape and its tinted ring
       becomes cloth. */
    const [ax, ay] = toImage(L, T);
    const [bx, by] = toImage(R, T);
    const [cx2, cy2] = toImage(R, B);
    const [dx2, dy2] = toImage(L, B);
    const px0 = Math.max(0, Math.floor(Math.min(ax, bx, cx2, dx2, x0)) - 3);
    const py0 = Math.max(0, Math.floor(Math.min(ay, by, cy2, dy2, y0)) - 3);
    const px1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx2, dx2, x0 + bw - 1)) + 3);
    const py1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy2, dy2, y0 + bh - 1)) + 3);
    const lp = [0, 0, 0, 0];
    const under = [0, 0, 0];
    let shapePx = 0;
    let clothPx = 0;
    for (let y = py0; y <= py1; y++) {
      for (let x = px0; x <= px1; x++) {
        const i = (y * w + x) * ch;
        const lx = x - x0;
        const ly = y - y0;
        const inBox = lx >= 0 && ly >= 0 && lx < bw && ly < bh;
        const inShape = inBox && filled[ly * bw + lx] === 1;
        const tinted = isTinted(data, i, key) && (inShape || near(x, y));
        const [u, v] = toLocal(x, y);
        /* Signed coverage of the label rect at this pixel (anti-aliasing). */
        const cov =
          Math.min(1, Math.max(0, u - L + 0.5)) *
          Math.min(1, Math.max(0, R - u + 0.5)) *
          Math.min(1, Math.max(0, v - T + 0.5)) *
          Math.min(1, Math.max(0, B - v + 0.5));
        const occluded = v < topAt(u) - occludeTol || (!inShape && !tinted && gapCol(u));
        if (inShape) shapePx++;
        if (cov > 0 && !occluded) {
          if (inShape || tinted) clothFill(u, v, under);
          else {
            under[0] = data[i];
            under[1] = data[i + 1];
            under[2] = data[i + 2];
          }
          sampleLabel(((u - L) * lw) / (R - L) - 0.5, ((v - T) * lh) / (B - T) - 0.5, lp);
          const shade = lightAt(x, y);
          const a = (lp[3] / 255) * cov;
          for (let j = 0; j < 3; j++) {
            const lab3 = Math.max(0, Math.min(255, lp[j] * shade));
            out[i + j] = Math.round(lab3 * a + under[j] * (1 - a));
          }
          if (inShape && cov < 1) clothPx += 1 - cov;
          continue;
        }
        if (inShape || tinted) {
          clothFill(u, v, under);
          for (let j = 0; j < 3; j++) out[i + j] = Math.round(under[j]);
          if (inShape) clothPx++;
        }
      }
    }
    return shapePx ? clothPx / shapePx : 0;

    /** Within a few pixels of the shape — a tinted halo pixel worth repainting. */
    function near(x: number, y: number) {
      for (let d = 1; d <= 6; d++) {
        for (const [ox, oy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
          const lx = x + ox - x0;
          const ly = y + oy - y0;
          if (lx >= 0 && ly >= 0 && lx < bw && ly < bh && filled[ly * bw + lx]) return true;
        }
      }
      return false;
    }
  }

  /** Paint out the key-coloured pixels still inside the zones — and their
   *  tinted halo — with the nearest cloth on the same row. */
  function cleanResidue(zones: Array<[number, number, number, number]>) {
    const bad = new Uint8Array(n);
    let any = false;
    const inZone = (x: number, y: number) => zones.some(([a, b, c2, d]) => x >= a && x <= c2 && y >= b && y <= d);
    for (let y = 0; y < h; y++) {
      for (let x = rx0; x <= rx1; x++) {
        const p = y * w + x;
        if (isCore(out, p * ch, key) && inZone(x, y)) {
          bad[p] = 1;
          any = true;
        }
      }
    }
    if (!any) return;
    /* Grow through the halo (still tinted) so no pink rim is left. */
    for (let pass = 0; pass < 6; pass++) {
      const grow: number[] = [];
      for (let y = 0; y < h; y++) {
        for (let x = rx0; x <= rx1; x++) {
          const p = y * w + x;
          if (bad[p] || !isTinted(out, p * ch, key)) continue;
          if ((x > 0 && bad[p - 1]) || (x < w - 1 && bad[p + 1]) || (y > 0 && bad[p - w]) || (y < h - 1 && bad[p + w])) grow.push(p);
        }
      }
      if (!grow.length) break;
      for (const p of grow) bad[p] = 1;
    }
    /* Each run of bad pixels down a column takes the cloth just above and just
       below it, shifted by the run's length (the weave carries on, no smear),
       cross-faded so both ends meet the real cloth. */
    const fill = Buffer.from(out);
    for (let x = rx0; x <= rx1; x++) {
      for (let y = 0; y < h; y++) {
        if (!bad[y * w + x]) continue;
        let y1 = y;
        while (y1 + 1 < h && bad[(y1 + 1) * w + x]) y1++;
        const len = y1 - y + 1;
        /* Above a placeholder is usually the shirt hem: when the cloth above
           and below the run differ, only the cloth below fills it. */
        const ia = y > 0 ? ((y - 1) * w + x) * ch : -1;
        const ib = y1 + 1 < h ? ((y1 + 1) * w + x) * ch : -1;
        const unlike =
          ia >= 0 && ib >= 0 && Math.hypot(out[ia] - out[ib], out[ia + 1] - out[ib + 1], out[ia + 2] - out[ib + 2]) > 45;
        for (let yy = y; yy <= y1; yy++) {
          const up = yy - len - 1;
          const dn = yy + len + 1;
          const okUp = up >= 0 && !bad[up * w + x] && !(unlike && dn < h && !bad[dn * w + x]);
          const okDn = dn < h && !bad[dn * w + x];
          const t = len > 1 ? (yy - y) / (len - 1) : 0.5;
          const i = (yy * w + x) * ch;
          for (let j = 0; j < 3; j++) {
            const a = okUp ? out[(up * w + x) * ch + j] : -1;
            const b = okDn ? out[(dn * w + x) * ch + j] : -1;
            fill[i + j] = a >= 0 && b >= 0 ? Math.round(a * (1 - t) + b * t) : a >= 0 ? a : b >= 0 ? b : out[i + j];
          }
        }
        y = y1;
      }
    }
    fill.copy(out);
  }
}
