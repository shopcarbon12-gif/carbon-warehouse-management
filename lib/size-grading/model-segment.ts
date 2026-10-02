/**
 * Finding the garment with a neural network, so nobody has to point at it.
 *
 * WHY
 *
 * Every earlier attempt asked the operator to help: tap the garment, nudge a
 * sensitivity, re-tap. That is the part they objected to, and they were right —
 * the job is "photograph it and get the measurements", not "supervise a
 * segmentation". This runs a salient-object model over the photo and returns
 * the garment with no input at all.
 *
 * WHICH MODEL, AND WHY NOT THE BEST ONE
 *
 * U²-Netp, 4 MB. BiRefNet-lite is the better model on paper and was the first
 * choice, until both were run over the same photos: BiRefNet wanted 93 MB and
 * ~10 s per photo on a desktop CPU, U²-Netp wanted 4 MB and ~2 s, and the masks
 * were the same to within a fifth of a percent of frame coverage. A warehouse
 * phone cannot afford the first and does not benefit from it. If a hard photo
 * ever shows the difference, MODEL is one line to change — the rest of this
 * file does not care which model it is driving.
 *
 * WHERE IT RUNS
 *
 * In the browser, on the operator's own device. No photo leaves the building,
 * there is no per-photo cost, it works when the warehouse internet does not,
 * and the same photo always produces the same mask — which matters for a
 * measurement that will be compared against a factory tolerance. The runtime
 * and the weights are served from this origin and cached by the browser, so the
 * ~17 MB is paid once.
 *
 * It is a PROPOSAL, never the answer. Whatever comes back is drawn as movable
 * measurement lines the operator can correct, and if the model fails to load or
 * run, the caller falls back to the colour-model segmentation. Nothing here is
 * allowed to leave someone unable to measure a garment.
 */

import type { ShirtMask } from "./measure";
import { dilate, erode, fillHoles } from "./measure";

/** The model, its input size, and how it wants pixels. */
const MODEL = {
  url: "/size-grading/model/u2netp.onnx",
  size: 320,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
} as const;

type Ort = typeof import("onnxruntime-web/wasm");
let sessionPromise: Promise<{ ort: Ort; session: import("onnxruntime-web/wasm").InferenceSession }> | null = null;

/**
 * Load the runtime and the weights once, and keep them.
 *
 * Deliberately not loaded with the page: it is ~17 MB that only matters once a
 * photo exists, and the Size Grading page is also opened to look things up.
 */
function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    /* The wasm-only entry, not the default. The default bundle loads the
       WebGPU-capable runtime — 27 MB — and requests different file names, so a
       server holding the plain runtime answers 404 and every photo silently
       falls back to the colour model while looking as though it worked. This
       entry is 13 MB and asks for exactly the files the build puts in /ort/. */
    const ort = await import("onnxruntime-web/wasm");
    /* Served from our own origin so the warehouse does not depend on a CDN, and
       single-threaded on purpose: threaded wasm needs cross-origin isolation
       (COOP/COEP) which would have to be set for the whole app, and the gain is
       not worth making every other page pay for it. */
    ort.env.wasm.wasmPaths = "/ort/";
    ort.env.wasm.numThreads = 1;
    const session = await ort.InferenceSession.create(MODEL.url, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    return { ort, session };
  })().catch((e) => {
    // Let a later photo try again rather than failing for the rest of the session.
    sessionPromise = null;
    throw e;
  });
  return sessionPromise;
}

/** Start fetching the model before it is needed, if the browser is idle. */
export function warmUpSegmenter() {
  if (typeof window === "undefined") return;
  void getSession().catch(() => {
    /* the caller will fall back; nothing to say here */
  });
}

export type ModelSegmentOptions = {
  /** Regions that cannot be garment — the calibration target. */
  exclude?: Array<{ x: number; y: number; w: number; h: number }>;
};

/**
 * Segment the garment. Throws if the model cannot run, so the caller can fall
 * back to something that always works.
 */
export async function segmentWithModel(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  opts: ModelSegmentOptions = {},
): Promise<ShirtMask> {
  const { ort, session } = await getSession();
  const S = MODEL.size;

  /* Area-averaged down to the model's input. Nearest-neighbour here drops thin
     parts of a garment — a spaghetti strap, a belt loop — before the model ever
     sees them, and the model cannot find what was never sampled. */
  const input = new Float32Array(3 * S * S);
  const sxStep = width / S;
  const syStep = height / S;
  for (let y = 0; y < S; y++) {
    const y0 = Math.floor(y * syStep);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * syStep)));
    for (let x = 0; x < S; x++) {
      const x0 = Math.floor(x * sxStep);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * sxStep)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx++) {
          const i = (row + xx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
          n++;
        }
      }
      if (!n) n = 1;
      const px = [r / n / 255, g / n / 255, b / n / 255];
      for (let c = 0; c < 3; c++) input[c * S * S + y * S + x] = (px[c] - MODEL.mean[c]) / MODEL.std[c];
    }
  }

  const feeds = { [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, S, S]) };
  const out = await session.run(feeds);
  const probs = out[session.outputNames[0]].data as Float32Array;

  /* U²-Net's output is unnormalised salience, not a probability, so it is
     scaled to its own range before thresholding. A fixed cut on raw values
     would move with the picture. */
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < S * S; i++) {
    if (probs[i] < lo) lo = probs[i];
    if (probs[i] > hi) hi = probs[i];
  }
  const span = Math.max(1e-6, hi - lo);

  const small = new Uint8Array(S * S);
  for (let i = 0; i < S * S; i++) small[i] = (probs[i] - lo) / span > 0.5 ? 1 : 0;

  // Back to the working image's size.
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const my = Math.min(S - 1, Math.floor((y * S) / height));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(S - 1, Math.floor((x * S) / width));
      data[y * width + x] = small[my * S + mx];
    }
  }

  /* The calibration target is a bright printed rectangle sitting next to the
     garment, which is exactly the kind of thing a salience model likes. Its
     position is known exactly, so it is removed rather than hoped against. */
  for (const r of opts.exclude ?? []) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) data[y * width + x] = 0;
    }
  }

  // Smooth the staircase that upscaling a 320 px mask leaves on the edges.
  const rad = Math.max(1, Math.round(Math.min(width, height) / 260));
  let mask = dilate(data, width, height, rad);
  mask = erode(mask, width, height, rad);
  mask = erode(mask, width, height, rad);
  mask = dilate(mask, width, height, rad);
  mask = fillHoles(mask, width, height);

  // Keep the biggest piece. A second garment at the edge of the table, or the
  // operator's hand, is not part of this measurement.
  mask = largestComponent(mask, width, height);

  let area = 0;
  for (let i = 0; i < mask.length; i++) area += mask[i];
  return { data: mask, width, height, area };
}

function largestComponent(src: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  const seen = new Uint8Array(n);
  const out = new Uint8Array(n);
  let best: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!src[start] || seen[start]) continue;
    const group: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      group.push(p);
      const x = p % width;
      const y = (p / width) | 0;
      if (x > 0 && src[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
      if (x < width - 1 && src[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
      if (y > 0 && src[p - width] && !seen[p - width]) { seen[p - width] = 1; stack.push(p - width); }
      if (y < height - 1 && src[p + width] && !seen[p + width]) { seen[p + width] = 1; stack.push(p + width); }
    }
    if (group.length > best.length) best = group;
  }
  for (const p of best) out[p] = 1;
  return out;
}
