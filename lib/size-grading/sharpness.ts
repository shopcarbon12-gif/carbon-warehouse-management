/**
 * How sharp is this photo, in the place that matters?
 *
 * A measurement read off a blurred photo is wrong in the one way nobody
 * notices: the number still looks like a number. A soft edge spreads the
 * garment's boundary over ten pixels instead of one, and the segmentation has
 * to put the line somewhere inside that smear — so a hem reads a centimetre
 * wide of the truth and the size chart is consulted in good faith about a
 * garment that was never measured.
 *
 * The metric is contrast-normalised edge energy: the average strength of a
 * Laplacian (how fast brightness changes from pixel to pixel) divided by how
 * much brightness variation there is to begin with. Dividing by the contrast is
 * what makes one threshold work on a dark warehouse floor and a bright table —
 * without it, a dim photo of a sharp garment scores the same as a bright photo
 * of a blurred one.
 *
 * Blur is measured in PIXELS, so the reading depends on the scale you hand it.
 * That is deliberate: the question is never "is this photo sharp in the
 * abstract" but "are the edges crisp at the size we are about to measure
 * them", so each caller passes the pixels it actually works with.
 *
 * A flat, featureless region has neither edges nor contrast, and no amount of
 * focus will give it either. That is reported as "flat" — not enough to judge —
 * rather than as blur, because telling an operator their photo is soft when it
 * is really just a white garment on a white table sends them chasing nothing.
 */

export type FocusVerdict = "sharp" | "usable" | "soft" | "flat";

export type FocusReading = {
  /** Contrast-normalised edge energy. Higher is sharper. */
  score: number;
  /** Standard deviation of brightness — how much detail there is to judge. */
  contrast: number;
  verdict: FocusVerdict;
};

export type FocusRect = { x: number; y: number; w: number; h: number };

/*
 * The thresholds are measured, not guessed — `scripts/test-sharpness.ts` puts a
 * synthetic garment through the same blur and the same two resizes a real photo
 * takes, and the two populations do not overlap anywhere near these lines:
 *
 *   in focus ............ 10.0
 *   blurred by 0.4% of the frame .. 0.7
 *   blurred by 1.5% (the photo the phone sent) .. 0.3
 *
 * A fourteen-fold gap is a comfortable place to put a threshold. Re-run that
 * script after changing anything here; the numbers move with the resize chain.
 */
/** Above this, edges are crisp enough that the boundary is where it looks. */
export const SHARP_SCORE = 6;
/** Below this, the measurement is not worth saving against an item. */
export const USABLE_SCORE = 3;
/** Below this much brightness variation there is nothing to judge focus on. */
export const MIN_CONTRAST = 7;

export function focusReading(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  rect?: FocusRect,
): FocusReading {
  const x0 = Math.max(1, Math.round(rect?.x ?? 0));
  const y0 = Math.max(1, Math.round(rect?.y ?? 0));
  const x1 = Math.min(width - 2, Math.round((rect ? rect.x + rect.w : width) - 1));
  const y1 = Math.min(height - 2, Math.round((rect ? rect.y + rect.h : height) - 1));
  if (x1 <= x0 || y1 <= y0) return { score: 0, contrast: 0, verdict: "flat" };

  const gray = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  };

  let sum = 0;
  let sumSq = 0;
  let lapSum = 0;
  let n = 0;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = gray(x, y);
      // Four-neighbour Laplacian: how far this pixel sits from its surroundings.
      const lap = Math.abs(4 * c - gray(x - 1, y) - gray(x + 1, y) - gray(x, y - 1) - gray(x, y + 1));
      lapSum += lap;
      sum += c;
      sumSq += c * c;
      n++;
    }
  }
  if (!n) return { score: 0, contrast: 0, verdict: "flat" };

  const mean = sum / n;
  const contrast = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  // +2 keeps a near-black region from dividing its way to a huge score.
  const score = (100 * (lapSum / n)) / (contrast + 2);

  const verdict: FocusVerdict =
    contrast < MIN_CONTRAST ? "flat" : score >= SHARP_SCORE ? "sharp" : score >= USABLE_SCORE ? "usable" : "soft";

  return { score, contrast, verdict };
}

/**
 * Draw a region of a video frame or image into an offscreen canvas at a known
 * size, so focus is always judged at a comparable pixel scale.
 *
 * Browser-only (it needs a canvas), and returns null rather than throwing when
 * there is nothing to read yet — a <video> that has not produced a frame has
 * zero dimensions, and a camera that was just opened is exactly that.
 */
export function sampleForFocus(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  size = 480,
  fraction = 0.6,
): ImageData | null {
  if (!srcW || !srcH) return null;
  // The middle of the frame: where the garment is, and where a phone's
  // autofocus is looking. The corners are table and floor.
  const cw = Math.max(1, Math.round(srcW * fraction));
  const ch = Math.max(1, Math.round(srcH * fraction));
  const sx = Math.round((srcW - cw) / 2);
  const sy = Math.round((srcH - ch) / 2);
  const scale = Math.min(1, size / Math.max(cw, ch));
  const w = Math.max(8, Math.round(cw * scale));
  const h = Math.max(8, Math.round(ch * scale));
  try {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(source, sx, sy, cw, ch, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } catch {
    return null; // a tainted or not-yet-ready source
  }
}
