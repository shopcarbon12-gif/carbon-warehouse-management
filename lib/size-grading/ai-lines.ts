/**
 * The AI's measuring lines, snapped onto the real edge of the garment.
 *
 * WHY
 *
 * A vision model understands a garment photo the way the operator does: it
 * knows which object is the garment and not the table, the scraps or the
 * target, which leg to measure, where the crotch, the hem and the waistband
 * are. What it cannot do is point precisely — on the owner's photos gpt-5.5's
 * ends landed 1–4 cm from the edge, some of them on the table. Every
 * segmentation model tried had the opposite problem: precise edges, the wrong
 * object on cluttered or dark surfaces.
 *
 * So the model decides WHAT and roughly WHERE, and the photo decides EXACTLY
 * WHERE. The model also names points that are certainly on the garment and
 * points certainly not; their colours tell a strip of pixels whether it looks
 * like fabric. Each end of a width line walks from where the model put it to
 * the first place fabric starts or stops. Seams are built from the snapped
 * corners, never guessed separately.
 *
 * Pure: the browser and the tests run the same code.
 */

import type { PomKey } from "./garment";
import { dilate, erode, fillHoles, type Point, type Segment, type ShirtMask } from "./measure";

/** What the model returns, on the 0–1000 grid drawn over the picture. */
export type AiReading = {
  garment: string;
  description?: string;
  box?: [number, number, number, number];
  on: Array<[number, number]>;
  off: Array<[number, number]>;
  lines: Partial<Record<string, { a: [number, number]; b: [number, number] } | null>>;
};

/** Width lines: both ends are on the garment's edge. */
const WIDTHS = new Set<string>([
  "chest", "waist", "hip", "hem", "shoulder", "bicep", "cuff",
  "thigh", "knee", "calf", "legOpening",
]);

type Rgb = [number, number, number];

function sample(px: Uint8ClampedArray, w: number, h: number, x: number, y: number, r = 1): Rgb | null {
  let n = 0, R = 0, G = 0, B = 0;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const xx = Math.round(x + dx), yy = Math.round(y + dy);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const i = (yy * w + xx) * 4;
      R += px[i]; G += px[i + 1]; B += px[i + 2]; n++;
    }
  }
  return n ? [R / n, G / n, B / n] : null;
}

const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** A colour → "does this look like the garment": nearer its colours than any of the surroundings'. */
type Looks = (c: Rgb) => boolean;
function looksFrom(garment: Rgb[], ground: Rgb[]): Looks {
  return (c) => {
    const dg = Math.min(...garment.map((g) => dist(c, g)));
    const db = ground.length ? Math.min(...ground.map((g) => dist(c, g))) : dg + 60;
    return dg < db;
  };
}

/** Per-pixel version, for the crotch search. */
function classifier(px: Uint8ClampedArray, w: number, h: number, look: Looks) {
  return (x: number, y: number): boolean | null => {
    const c = sample(px, w, h, x, y, 1);
    return c ? look(c) : null;
  };
}

/**
 * Mean colour of a short strip across the line at distance t along it.
 * Averaging across the line is what stops wood grain, fabric texture and a
 * seam from looking like an edge: they do not run the same way for 8 mm.
 */
function strip(px: Uint8ClampedArray, w: number, h: number, o: Point, u: Point, t: number, half: number): Rgb | null {
  let n = 0, R = 0, G = 0, B = 0;
  const vx = -u.y, vy = u.x;
  for (let s = -half; s <= half; s++) {
    const x = Math.round(o.x + u.x * t + vx * s), y = Math.round(o.y + u.y * t + vy * s);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = (y * w + x) * 4;
    R += px[i]; G += px[i + 1]; B += px[i + 2]; n++;
  }
  return n ? [R / n, G / n, B / n] : null;
}

/**
 * Move one end of a line onto the garment's edge.
 *
 * From where the model put the end: if that is on the fabric, walk outwards to
 * the first place the fabric stops; if it is off the fabric, walk inwards to
 * the first place it starts. The FIRST change, not the strongest one in reach
 * — the strongest can be the other leg, or the edge of the paper. Then settle
 * on the sharpest step within a few millimetres of it. An end with no change
 * within `reachCm` stays where the model put it: a visible, draggable guess
 * beats a confident wrong snap.
 */
function snapEnd(
  px: Uint8ClampedArray, w: number, h: number, look: Looks,
  end: Point, outward: Point, pxPerCm: number, reachCm = 5,
): Point {
  const reach = Math.round(reachCm * pxPerCm);
  const half = Math.max(2, Math.round(pxPerCm * 0.4));
  const hold = Math.max(2, Math.round(pxPerCm * 0.3)); // a change must last 3 mm
  const isG = (t: number) => {
    const c = strip(px, w, h, end, outward, t, half);
    return c ? look(c) : null;
  };
  const start = isG(0);
  if (start === null) return end;
  const dir = start ? 1 : -1; // on fabric: go out; off it: come in
  let edge: number | null = null;
  for (let t = 0, run = 0; Math.abs(t) <= reach; t += dir) {
    const v = isG(t);
    if (v === null) break;
    if (v !== start) {
      run++;
      if (run >= hold) { edge = t - dir * (hold - 1); break; }
    } else run = 0;
  }
  if (edge === null) return end;
  // The sharpest step near it, from fabric (inside) to not (outside).
  const d = Math.max(1, Math.round(pxPerCm * 0.2));
  let best = -Infinity, bestT = edge;
  for (let t = edge - 2 * d; t <= edge + 2 * d; t++) {
    const inside = strip(px, w, h, end, outward, t - d, half), outside = strip(px, w, h, end, outward, t + d, half);
    if (!inside || !outside) continue;
    const step = dist(inside, outside);
    if (step > best) { best = step; bestT = t; }
  }
  return { x: end.x + outward.x * bestT, y: end.y + outward.y * bestT };
}

function snapWidth(px: Uint8ClampedArray, w: number, h: number, look: Looks, a: Point, b: Point, pxPerCm: number): Segment {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 2) return { a, b };
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const sa = snapEnd(px, w, h, look, a, { x: -u.x, y: -u.y }, pxPerCm);
  const sb = snapEnd(px, w, h, look, b, u, pxPerCm);
  // Two ends that crossed over each other found the same edge twice: keep the model's.
  if ((sb.x - sa.x) * u.x + (sb.y - sa.y) * u.y < len * 0.4) return { a, b };
  return { a: sa, b: sb };
}

/** The crotch: top of the gap between the legs, near where the model put it. */
function snapCrotch(isG: ReturnType<typeof classifier>, c: Point, pxPerCm: number): Point {
  const below = c.y + 3 * pxPerCm;
  // The gap run on a row a little below the crotch, nearest the model's x.
  const span = 8 * pxPerCm;
  let gx: number | null = null, bestD = Infinity;
  for (let x = c.x - span; x <= c.x + span; ) {
    if (isG(x, below) !== false) { x++; continue; }
    let e = x;
    while (e + 1 <= c.x + span && isG(e + 1, below) === false) e++;
    const mid = (x + e) / 2;
    // A gap is bounded by garment on both sides; the open table round the legs is not.
    if (isG(x - 2, below) && isG(e + 2, below) && Math.abs(mid - c.x) < bestD) { bestD = Math.abs(mid - c.x); gx = mid; }
    x = e + 1;
  }
  if (gx === null) return c;
  // Walk up the gap until fabric.
  for (let y = below; y > c.y - 6 * pxPerCm; y--) if (isG(gx, y) === true) return { x: gx, y };
  return c;
}

/**
 * The model's reading → lines on the picture, in picture pixels.
 * `width`/`height` are the picture's; coordinates come in on 0–1000.
 */
export function snapAiLines(
  px: Uint8ClampedArray,
  width: number,
  height: number,
  pxPerCm: number,
  ai: AiReading,
): Partial<Record<PomKey, Segment>> {
  const P = ([x, y]: [number, number]): Point => ({ x: (x / 1000) * width, y: (y / 1000) * height });
  const r = Math.max(1, Math.round(pxPerCm * 0.3));
  const colours = (pts: Array<[number, number]>) =>
    pts.map(P).map((p) => sample(px, width, height, p.x, p.y, r)).filter((c): c is Rgb => !!c);
  const garment = colours(ai.on), ground = colours(ai.off);
  if (!garment.length) {
    const raw: Partial<Record<string, Segment>> = {};
    for (const [k, l] of Object.entries(ai.lines)) if (l) raw[k] = { a: P(l.a), b: P(l.b) };
    return raw as Partial<Record<PomKey, Segment>>;
  }
  const look = looksFrom(garment, ground);
  const isG = classifier(px, width, height, look);
  const raw: Partial<Record<string, Segment>> = {};
  for (const [k, l] of Object.entries(ai.lines)) if (l) raw[k] = { a: P(l.a), b: P(l.b) };

  const out: Partial<Record<string, Segment>> = {};
  for (const [k, s] of Object.entries(raw)) if (s && WIDTHS.has(k)) out[k] = snapWidth(px, width, height, look, s.a, s.b, pxPerCm);

  /* Seams from corners. Which end of a width line is "outer" is decided by
     distance to the model's own seam ends, so the model's sense of which side
     is which carries over and nothing assumes a left or a right. */
  const nearer = (s: Segment | undefined, p: Point | undefined) =>
    s && p ? (Math.hypot(s.a.x - p.x, s.a.y - p.y) <= Math.hypot(s.b.x - p.x, s.b.y - p.y) ? s.a : s.b) : undefined;

  const crotchGuess = raw.inseam?.a ?? raw.rise?.b;
  const crotch = crotchGuess ? snapCrotch(isG, crotchGuess, pxPerCm) : undefined;

  if (raw.outseam) {
    const top = nearer(out.waist, raw.outseam.a) ?? raw.outseam.a;
    const bottom = nearer(out.legOpening, raw.outseam.b) ?? raw.outseam.b;
    out.outseam = { a: top, b: bottom };
  }
  if (raw.inseam) {
    const bottom = nearer(out.legOpening, raw.inseam.b) ?? raw.inseam.b;
    out.inseam = { a: crotch ?? raw.inseam.a, b: bottom };
  }
  if (raw.rise && crotch) {
    // Straight up from the crotch to the waistband's top edge.
    const w = out.waist;
    let topY = raw.rise.a.y;
    if (w && Math.abs(w.b.x - w.a.x) > 1) topY = w.a.y + ((crotch.x - w.a.x) * (w.b.y - w.a.y)) / (w.b.x - w.a.x);
    out.rise = { a: { x: crotch.x, y: topY }, b: crotch };
  } else if (raw.rise) out.rise = raw.rise;
  // Everything else as the model placed it: lengths along a garment, pockets, bands.
  for (const [k, s] of Object.entries(raw)) if (s && !out[k]) out[k] = s;
  return out as Partial<Record<PomKey, Segment>>;
}

/* ───────────────────────── the garment, from the AI's seeds ───────────────────────── */

/**
 * Cut the garment out using the model's reading as seeds.
 *
 * Fabric colours come from patches round the "on" points; surroundings from
 * the "off" points and from the frame just outside the model's box, which is
 * not garment by definition. Each pixel inside the box goes to whichever it is
 * nearer; the piece that holds the "on" points is the garment. A salience
 * model asked "what is the main object" answered "the table"; this is asked
 * "which of these two sets of colours", with the sets chosen by something that
 * knows which object is the garment.
 */
export function maskFromAi(px: Uint8ClampedArray, w: number, h: number, pxPerCm: number, ai: AiReading): ShirtMask | null {
  const P = ([x, y]: [number, number]): Point => ({ x: (x / 1000) * w, y: (y / 1000) * h });
  const r = Math.max(2, Math.round(pxPerCm * 0.6));
  const patch = (p: Point, rr: number) => {
    const out: Rgb[] = [];
    for (let dy = -rr; dy <= rr; dy += Math.max(1, rr >> 1)) {
      for (let dx = -rr; dx <= rr; dx += Math.max(1, rr >> 1)) {
        const c = sample(px, w, h, p.x + dx, p.y + dy, 1);
        if (c) out.push(c);
      }
    }
    return out;
  };
  /* An "on" point the model misplaced — on the paper beside the garment —
     would teach the cut that paper is fabric. A point counts only if its
     colour agrees with at least one other "on" point; a garment of several
     colours still has each colour at more than one point. */
  const centres = ai.on.map((p) => ({ p, c: sample(px, w, h, P(p).x, P(p).y, Math.max(1, r >> 1)) }));
  const agreed = centres.filter((a) => a.c && centres.some((b) => b !== a && b.c && dist(a.c!, b.c) < 45));
  /* 30, not 45: near-black wood grain is within 45 of black leggings, and
     with it in the fabric set the cut-out took the table with it. */
  const fabric = (agreed.length ? agreed : centres)
    .flatMap((a) => patch(P(a.p), r))
    .filter((c) => (agreed.length ? agreed.some((a) => dist(c, a.c!) < 30) : true));
  if (!fabric.length) return null;
  const seeds = (agreed.length ? agreed : centres).map((a) => a.p);
  const ground = ai.off.flatMap((p) => patch(P(p), r));
  const box = ai.box ?? [0, 0, 1000, 1000];
  const m = 0.04 * 1000;
  const x0 = Math.max(0, Math.floor(((box[0] - m) / 1000) * w)), y0 = Math.max(0, Math.floor(((box[1] - m) / 1000) * h));
  const x1 = Math.min(w - 1, Math.ceil(((box[2] + m) / 1000) * w)), y1 = Math.min(h - 1, Math.ceil(((box[3] + m) / 1000) * h));
  /* The rim of the grown box is surroundings — mostly. The model draws the box
     tight, and where its edge crosses the garment (it ran across both hems) a
     rim sample is fabric in a deeper shade, which taught the cut that the hems
     were not leggings. So a rim sample anywhere near a fabric colour is
     dropped; the model's own "off" points still say what the table looks like. */
  const fabricLike = (c: Rgb) => Math.min(...fabric.map((g) => dist(c, g)));
  const rim: Rgb[] = [];
  const step = Math.max(4, Math.round(pxPerCm));
  for (let x = x0; x <= x1; x += step) for (const y of [y0, y1]) { const c = sample(px, w, h, x, y, 1); if (c) rim.push(c); }
  for (let y = y0; y <= y1; y += step) for (const x of [x0, x1]) { const c = sample(px, w, h, x, y, 1); if (c) rim.push(c); }
  const bg = [...ground.filter((c) => fabricLike(c) > 25), ...rim.filter((c) => fabricLike(c) > 60)];
  if (!bg.length) return null;

  /* Hundreds of samples, most of them near-duplicates: comparing every pixel
     with all of them took ~20 s on a desktop. Binned to 16 levels a channel,
     a dozen or two distinct colours are left, and the answer is the same. */
  const distinct = (cs: Rgb[]) => {
    const seen = new Map<number, Rgb>();
    for (const c of cs) {
      const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
      if (!seen.has(key)) seen.set(key, c);
    }
    return [...seen.values()];
  };
  const fab = distinct(fabric), gnd = distinct(bg);
  const raw = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      const r0 = px[i], g0 = px[i + 1], b0 = px[i + 2];
      // Squared distances, no allocation: this loop runs over a million pixels.
      let dg = Infinity, db = Infinity;
      for (let j = 0; j < fab.length; j++) {
        const f = fab[j], d = (r0 - f[0]) ** 2 + (g0 - f[1]) ** 2 + (b0 - f[2]) ** 2;
        if (d < dg) dg = d;
      }
      for (let j = 0; j < gnd.length && db > dg; j++) {
        const f = gnd[j], d = (r0 - f[0]) ** 2 + (g0 - f[1]) ** 2 + (b0 - f[2]) ** 2;
        if (d < db) db = d;
      }
      if (dg < db) raw[y * w + x] = 1;
    }
  }
  /* Close gaps (a crease, a highlight, a stripe), then open away anything thinner
     than about a centimetre: specks of dark wood grain clung to the hem and
     added 6 cm to the outseam. Nothing a garment is measured across is that thin. */
  // Up to ~1 cm: a tape measure, a contrast stripe or a seam line across the garment must not split it.
  const close = Math.max(1, Math.round(pxPerCm * 0.5));
  const open = Math.max(1, Math.round(pxPerCm * 0.5));
  let mask = erode(dilate(raw, w, h, close), w, h, close);
  mask = dilate(erode(mask, w, h, open), w, h, open);
  mask = fillHoles(mask, w, h);
  /* Nothing outside the model's own box, give or take 1.5 %: its boxes were
     tight on every photo, and a patch of floor touching the hem otherwise
     joins the garment and stretches the leg. */
  const t = 15;
  const bx0 = Math.max(0, Math.floor(((box[0] - t) / 1000) * w)), by0 = Math.max(0, Math.floor(((box[1] - t) / 1000) * h));
  const bx1 = Math.min(w - 1, Math.ceil(((box[2] + t) / 1000) * w)), by1 = Math.min(h - 1, Math.ceil(((box[3] + t) / 1000) * h));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < bx0 || x > bx1 || y < by0 || y > by1) mask[y * w + x] = 0;
  // Keep every piece that holds an "on" point (two legs can touch only at the crotch).
  const keep = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  for (const p of seeds.map(P)) {
    const sx = Math.round(p.x), sy = Math.round(p.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const start = sy * w + sx;
    if (!mask[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      keep[q] = 1;
      const x = q % w, y = (q / w) | 0;
      for (const n of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
        if (n >= 0 && mask[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
      }
    }
  }
  let area = 0;
  for (let i = 0; i < keep.length; i++) area += keep[i];
  return area ? { data: keep, width: w, height: h, area } : null;
}

/**
 * Whether a cut-out is the garment the model is looking at: it holds the
 * model's "on" points, misses its "off" points, and fills the model's box.
 * Null when it agrees, otherwise the reason — shown to the operator, so a
 * rejected cut-out is never silent.
 */
export function disagreesWithAi(mask: ShirtMask, ai: AiReading, pxPerCm: number): string | null {
  const { width: w, height: h, data } = mask;
  const inside = (px: number, py: number) => {
    const x = Math.round(px), y = Math.round(py);
    return x >= 0 && y >= 0 && x < w && y < h && !!data[y * w + x];
  };
  const at = ([x, y]: [number, number]) => inside((x / 1000) * w, (y / 1000) * h);
  /* The model's points are as imprecise as its lines: an "off" point it put
     just outside the leggings landed on their edge, and a correct cut-out was
     thrown away for it. An "off" point counts only when it is well inside —
     1.5 cm of garment all round it. */
  const deep = ([x, y]: [number, number]) => {
    const cx = (x / 1000) * w, cy = (y / 1000) * h, r = 1.5 * pxPerCm;
    if (!inside(cx, cy)) return false;
    for (let k = 0; k < 8; k++) if (!inside(cx + r * Math.cos((k * Math.PI) / 4), cy + r * Math.sin((k * Math.PI) / 4))) return false;
    return true;
  };
  const on = ai.on.filter(at).length;
  if (ai.on.length && on < Math.ceil(ai.on.length * 0.8)) return `it misses ${ai.on.length - on} of the ${ai.on.length} places the AI sees fabric`;
  const off = ai.off.filter(deep).length;
  if (off) return `it covers ${off} place${off === 1 ? "" : "s"} the AI says is not the garment`;
  if (ai.box) {
    let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const b = [(ai.box[0] / 1000) * w, (ai.box[1] / 1000) * h, (ai.box[2] / 1000) * w, (ai.box[3] / 1000) * h];
    const ix = Math.max(0, Math.min(x1, b[2]) - Math.max(x0, b[0])), iy = Math.max(0, Math.min(y1, b[3]) - Math.max(y0, b[1]));
    const inter = ix * iy, union = (x1 - x0) * (y1 - y0) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
    if (union > 0 && inter / union < 0.75) return "its outline does not match where the AI sees the garment";
  }
  return null;
}

/* ─────────────────────── the AI's lines, onto a clean cut-out ─────────────────────── */

/**
 * A width line onto the cut-out's edge: the run of garment along the line
 * that overlaps the model's line most. If the model's line sits just off the
 * garment — a waist line drawn a little above the waistband — it is moved
 * square to itself, by as little as possible, until it lies across the garment.
 */
function widthOnMask(at: (x: number, y: number) => boolean, a: Point, b: Point, pxPerCm: number): Segment | null {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len < 2) return null;
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
  const v = { x: -u.y, y: u.x };
  const reach = 5 * pxPerCm;
  const along = (o: Point) => {
    let best: [number, number] | null = null, bestOverlap = 0;
    let runStart: number | null = null;
    for (let t = -reach; t <= len + reach + 1; t++) {
      const inside = t <= len + reach && at(o.x + u.x * t, o.y + u.y * t);
      if (inside && runStart === null) runStart = t;
      if (!inside && runStart !== null) {
        const e = t - 1;
        const overlap = Math.max(0, Math.min(e, len) - Math.max(runStart, 0));
        if (overlap > bestOverlap) { bestOverlap = overlap; best = [runStart, e]; }
        runStart = null;
      }
    }
    return { best, bestOverlap };
  };
  const maxShift = Math.round(3 * pxPerCm);
  for (let k = 0; k <= maxShift; k++) {
    for (const sgn of k ? [1, -1] : [1]) {
      const d = k * sgn;
      const o = { x: a.x + v.x * d, y: a.y + v.y * d };
      const { best, bestOverlap } = along(o);
      if (best && bestOverlap >= len * 0.5) {
        return { a: { x: o.x + u.x * best[0], y: o.y + u.y * best[0] }, b: { x: o.x + u.x * best[1], y: o.y + u.y * best[1] } };
      }
    }
  }
  return null;
}

/**
 * The model's reading → lines on a clean cut-out of the garment.
 *
 * The lines are the model's — square across an angled leg, across the real
 * hem rather than its pointed corner — and every end that belongs on an edge
 * is on the cut-out's edge. Seams join snapped corners.
 */
export function aiLinesOnMask(ai: AiReading, mask: ShirtMask, pxPerCm: number): Partial<Record<PomKey, Segment>> {
  const { width: w, height: h, data } = mask;
  const P = ([x, y]: [number, number]): Point => ({ x: (x / 1000) * w, y: (y / 1000) * h });
  const at = (x: number, y: number) => {
    const xx = Math.round(x), yy = Math.round(y);
    return xx >= 0 && yy >= 0 && xx < w && yy < h && !!data[yy * w + xx];
  };
  const raw: Partial<Record<string, Segment>> = {};
  for (const [k, l] of Object.entries(ai.lines)) if (l) raw[k] = { a: P(l.a), b: P(l.b) };
  const out: Partial<Record<string, Segment>> = {};
  for (const [k, s] of Object.entries(raw)) {
    if (!s || !WIDTHS.has(k)) continue;
    const snapped = widthOnMask(at, s.a, s.b, pxPerCm);
    if (snapped) out[k] = snapped;
  }
  const nearer = (s: Segment | undefined, p: Point | undefined) =>
    s && p ? (Math.hypot(s.a.x - p.x, s.a.y - p.y) <= Math.hypot(s.b.x - p.x, s.b.y - p.y) ? s.a : s.b) : undefined;
  const crotchGuess = raw.inseam?.a ?? raw.rise?.b;
  const crotch = crotchGuess ? snapCrotch((x, y) => at(x, y), crotchGuess, pxPerCm) : undefined;
  if (raw.outseam) out.outseam = { a: nearer(out.waist, raw.outseam.a) ?? raw.outseam.a, b: nearer(out.legOpening, raw.outseam.b) ?? raw.outseam.b };
  if (raw.inseam) out.inseam = { a: crotch ?? raw.inseam.a, b: nearer(out.legOpening, raw.inseam.b) ?? raw.inseam.b };
  if (raw.rise && crotch) {
    const wl = out.waist;
    let topY = raw.rise.a.y;
    if (wl && Math.abs(wl.b.x - wl.a.x) > 1) topY = wl.a.y + ((crotch.x - wl.a.x) * (wl.b.y - wl.a.y)) / (wl.b.x - wl.a.x);
    out.rise = { a: { x: crotch.x, y: topY }, b: crotch };
  }
  for (const [k, s] of Object.entries(raw)) if (s && !out[k]) out[k] = s;
  return out as Partial<Record<PomKey, Segment>>;
}
