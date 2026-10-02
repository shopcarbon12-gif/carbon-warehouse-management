/**
 * Separating the garment from everything else in the photo.
 *
 * WHY THE FLOOD FILL WASN'T GOOD ENOUGH
 *
 * The previous approach grew a region outward from where the operator tapped,
 * accepting any neighbouring pixel within a colour distance of the seed. That
 * fails in two directions at once on a real floor. Set the tolerance low and
 * the garment's own shading — a fold, a shadow under a sleeve, a sheen — stops
 * the growth, so half the garment is missing. Set it high and the growth walks
 * through a gradient into the table, the floor and whatever else is touching,
 * because each step only ever compares against its neighbour. There is no
 * tolerance that is right for both, which is why tuning that slider never
 * settled anywhere good.
 *
 * WHAT THIS DOES INSTEAD
 *
 * It learns what the garment looks like and what the background looks like, and
 * then judges every pixel against both. The garment's colours come from around
 * the tap; the background's come from the edges of the frame, which is table,
 * floor and whatever else is lying about. A pixel joins the garment when it
 * looks more like the garment than like the background — a comparison, not a
 * threshold, so a shaded fold still reads as garment (it is far closer to
 * garment-colour than to wood) and a patch of table does not (the reverse).
 *
 * Colour is judged in a rough opponent space rather than RGB, so that shading —
 * which moves brightness a lot and hue hardly at all — counts for much less
 * than colour does. That is what lets a fold stay inside the garment.
 *
 * The result is then reduced to the one connected region containing the tap, so
 * a second green thing elsewhere in the frame cannot join in, and holes inside
 * it are filled.
 */

import { dilate, erode, fillHoles, type Point, type ShirtMask } from "./measure";

/** 16 levels per channel: fine enough to tell fabrics apart, coarse enough to generalise. */
const BINS = 16;
const SHIFT = 4; // 256 / 16

function binOf(r: number, g: number, b: number): number {
  /* A rough opponent space. Brightness is kept but quantised coarsely, so a
     shadow on the garment lands in the same neighbourhood as the lit part,
     while the two colour axes — which shading barely touches — stay sharp. */
  const lum = (r * 299 + g * 587 + b * 114) / 1000;
  const rg = 128 + (r - g) / 2;
  const by = 128 + (b - (r + g) / 2) / 2;
  const L = Math.min(BINS - 1, Math.max(0, Math.round(lum / SHIFT / 2)));
  const A = Math.min(BINS - 1, Math.max(0, Math.round(rg / SHIFT)));
  const B = Math.min(BINS - 1, Math.max(0, Math.round(by / SHIFT)));
  return (L * BINS + A) * BINS + B;
}

export type SegmentOptions = {
  /** Rectangles that are definitely NOT garment — the calibration target. */
  exclude?: Array<{ x: number; y: number; w: number; h: number }>;
  /**
   * How readily a pixel joins the garment. 0 is neutral — the honest
   * comparison. Positive is more generous, negative stricter. Exposed so the
   * operator has one meaningful control instead of a raw colour tolerance.
   */
  bias?: number;
};

/**
 * Segment the garment around `seed`.
 *
 * Returns a mask the same size as the image.
 */
export function segmentGarment(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  seed: Point,
  opts: SegmentOptions = {},
): ShirtMask {
  const n = width * height;
  const fg = new Float64Array(BINS * BINS * BINS);
  const bg = new Float64Array(BINS * BINS * BINS);

  const excluded = (x: number, y: number) =>
    (opts.exclude ?? []).some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

  const at = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return binOf(rgba[i], rgba[i + 1], rgba[i + 2]);
  };

  /* The garment's colours: a disc around the tap. Small enough to stay on the
     garment even when the tap is near an edge, big enough to see more than one
     thread of it. */
  const sx = Math.round(seed.x);
  const sy = Math.round(seed.y);
  const rFg = Math.max(6, Math.round(Math.min(width, height) * 0.045));
  for (let y = Math.max(0, sy - rFg); y <= Math.min(height - 1, sy + rFg); y++) {
    for (let x = Math.max(0, sx - rFg); x <= Math.min(width - 1, sx + rFg); x++) {
      if ((x - sx) ** 2 + (y - sy) ** 2 > rFg * rFg) continue;
      fg[at(x, y)] += 1;
    }
  }

  /* The background's colours: a band around the edge of the frame, plus
     anything the caller knows is not garment. Shooting a garment laid flat
     means the frame's edge is table and floor by construction — and when the
     operator has framed it tightly, this band is still the best available
     statement of "not the thing in the middle". */
  const band = Math.max(4, Math.round(Math.min(width, height) * 0.07));
  for (let y = 0; y < height; y++) {
    const edgeRow = y < band || y >= height - band;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x >= band && x < width - band) continue;
      bg[at(x, y)] += 1;
    }
  }
  for (const r of opts.exclude ?? []) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) bg[at(x, y)] += 1;
    }
  }

  // Smooth both histograms over neighbouring bins so an unseen shade of the
  // garment is not treated as unknown just because that exact bin was empty.
  const smooth = (h: Float64Array) => {
    const out = new Float64Array(h.length);
    for (let l = 0; l < BINS; l++) {
      for (let a = 0; a < BINS; a++) {
        for (let b = 0; b < BINS; b++) {
          let s = 0;
          for (let dl = -1; dl <= 1; dl++) {
            for (let da = -1; da <= 1; da++) {
              for (let db = -1; db <= 1; db++) {
                const L = l + dl;
                const A = a + da;
                const B = b + db;
                if (L < 0 || A < 0 || B < 0 || L >= BINS || A >= BINS || B >= BINS) continue;
                s += h[(L * BINS + A) * BINS + B];
              }
            }
          }
          out[(l * BINS + a) * BINS + b] = s;
        }
      }
    }
    return out;
  };
  const fgS = smooth(fg);
  const bgS = smooth(bg);
  let fgTotal = 0;
  let bgTotal = 0;
  for (let i = 0; i < fgS.length; i++) {
    fgTotal += fgS[i];
    bgTotal += bgS[i];
  }
  if (fgTotal <= 0 || bgTotal <= 0) {
    return { data: new Uint8Array(n), width, height, area: 0 };
  }

  /* Log-odds per pixel: more like the garment, or more like the background?
     The epsilon keeps a colour seen in neither from dividing by zero; a colour
     seen in neither is genuinely unknown and lands near zero, which the bias
     then decides. */
  const eps = 1e-6;
  const raw = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (excluded(x, y)) continue;
      const bin = at(x, y);
      const pF = fgS[bin] / fgTotal + eps;
      const pB = bgS[bin] / bgTotal + eps;
      if (Math.log(pF / pB) + (opts.bias ?? 0) > 0) raw[y * width + x] = 1;
    }
  }

  /* Tidy up, then keep only what the tap is actually part of. Opening first
     removes the speckle a per-pixel decision always leaves; closing bridges the
     seams and prints that split a garment into pieces. */
  const r = Math.max(1, Math.round(Math.min(width, height) / 220));
  let mask = erode(raw, width, height, r);
  mask = dilate(mask, width, height, r);
  mask = dilate(mask, width, height, r);
  mask = erode(mask, width, height, r);

  const keep = componentAt(mask, width, height, sx, sy);
  const data = fillHoles(keep, width, height);
  let area = 0;
  for (let i = 0; i < data.length; i++) area += data[i];
  return { data, width, height, area };
}

/**
 * The one connected region containing (x, y).
 *
 * This is what stops a second green garment across the table, or a shadow the
 * colour model liked, from being measured as part of this one. If the tap
 * itself landed on background the nearest foreground pixel is used instead, so
 * a tap a few pixels off the edge still works.
 */
function componentAt(src: Uint8Array, width: number, height: number, x0: number, y0: number): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  let start = -1;
  if (x0 >= 0 && y0 >= 0 && x0 < width && y0 < height && src[y0 * width + x0]) {
    start = y0 * width + x0;
  } else {
    let bestD = Infinity;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!src[y * width + x]) continue;
        const d = (x - x0) ** 2 + (y - y0) ** 2;
        if (d < bestD) {
          bestD = d;
          start = y * width + x;
        }
      }
    }
  }
  if (start < 0) return out;

  const stack = [start];
  out[start] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p / width) | 0;
    if (x > 0 && src[p - 1] && !out[p - 1]) { out[p - 1] = 1; stack.push(p - 1); }
    if (x < width - 1 && src[p + 1] && !out[p + 1]) { out[p + 1] = 1; stack.push(p + 1); }
    if (y > 0 && src[p - width] && !out[p - width]) { out[p - width] = 1; stack.push(p - width); }
    if (y < height - 1 && src[p + width] && !out[p + width]) { out[p + width] = 1; stack.push(p + width); }
  }
  return out;
}
