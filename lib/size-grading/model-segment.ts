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
import { insideQuad, rectify, targetSheet, type Quad, type RectFrame } from "./target";
import { dilate, erode, fillHoles } from "./measure";

/** The model, its input size, and how it wants pixels. */
const MODEL = {
  url: "/size-grading/model/u2netp.onnx",
  size: 320,
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
} as const;

/** The square the model expects its input resized to. */
export const MODEL_INPUT_SIZE = MODEL.size;

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

/* The three stages are pure and exported so the SAME code runs in the browser
   (onnxruntime-web) and in scripts/test-size-grading-model.ts (onnxruntime-node).
   Testing a copy of this logic is how a pipeline passes its test and fails in
   the app. */

/** Pixels → the model's normalised input tensor, area-averaged. */
export function modelInput(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
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
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * width;
        for (let xx = x0; xx < x1; xx++) {
          const i = (row + xx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
        }
      }
      if (!n) n = 1;
      const px = [r / n / 255, g / n / 255, b / n / 255];
      for (let c = 0; c < 3; c++) input[c * S * S + y * S + x] = (px[c] - MODEL.mean[c]) / MODEL.std[c];
    }
  }
  return input;
}

/** The model's salience map → a binary mask at the photo's own size. */
export function modelOutputToMask(probs: Float32Array, width: number, height: number): Uint8Array {
  const S = MODEL.size;
  /* U²-Net's output is unnormalised salience, not a probability, so it is
     scaled to its own range before thresholding. A fixed cut on raw values
     would move with the picture. */
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < S * S; i++) {
    if (probs[i] < lo) lo = probs[i];
    if (probs[i] > hi) hi = probs[i];
  }
  const span = Math.max(1e-6, hi - lo);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const my = Math.min(S - 1, Math.floor((y * S) / height));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(S - 1, Math.floor((x * S) / width));
      data[y * width + x] = (probs[my * S + mx] - lo) / span > 0.5 ? 1 : 0;
    }
  }
  return data;
}

/**
 * Clean a raw mask in the space it will be measured in: drop the target,
 * smooth the upscaling staircase, fill holes, keep the biggest piece.
 */
export function finishMask(
  raw: Uint8Array,
  width: number,
  height: number,
  opts: ModelSegmentOptions = {},
): ShirtMask {
  const data = new Uint8Array(raw);
  /* The calibration target is a bright printed rectangle sitting next to the
     garment, which is exactly the kind of thing a salience model likes — on the
     owner's photo it was selected along with the leggings. Its position is
     known exactly, so it is removed rather than hoped against. */
  for (const r of opts.exclude ?? []) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++) data[y * width + x] = 0;
    }
  }
  const rad = Math.max(1, Math.round(Math.min(width, height) / 260));
  let mask = dilate(data, width, height, rad);
  mask = erode(mask, width, height, rad);
  mask = erode(mask, width, height, rad);
  mask = dilate(mask, width, height, rad);
  mask = fillHoles(mask, width, height);
  // Keep the biggest piece: a second garment, a hand, the hole in the table.
  mask = largestComponent(mask, width, height);
  let area = 0;
  for (let i = 0; i < mask.length; i++) area += mask[i];
  return { data: mask, width, height, area };
}

/**
 * Run the model on a photo and return its raw mask at the photo's size.
 *
 * Give it the PHOTO, not the squared-up image. Squaring up fills everything
 * outside the original frame with white, and on that canvas the whole photo is a
 * dark shape on white — so the model selected the entire picture, table and
 * all, which is exactly what the operator kept seeing. On the photo itself it
 * picks out the garment. Warp the result afterwards (see the workspace).
 */
export async function maskFromModel(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const { ort, session } = await getSession();
  const S = MODEL.size;
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", modelInput(rgba, width, height), [1, 3, S, S]),
  });
  return modelOutputToMask(out[session.outputNames[0]].data as Float32Array, width, height);
}

export function largestComponent(src: Uint8Array, width: number, height: number): Uint8Array {
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

/**
 * Bring the model's mask from the photo into measuring space, and clean it.
 *
 * Shared by the app and scripts/test-size-grading-photo.ts so the test runs the
 * code that ships rather than a copy of it. `quad` and `pxPerCm` are the ones the
 * picture was squared up with; without them the mask is just resized.
 */
export function maskForMeasuring(
  raw: Uint8Array,
  src: { width: number; height: number },
  out: { width: number; height: number },
  squared?: { quad: Quad; frame: RectFrame },
): ShirtMask {
  let inSpace: Uint8Array;
  if (squared) {
    // Carry the mask through the same transform as the picture, exactly.
    const rgba = new Uint8ClampedArray(src.width * src.height * 4);
    for (let i = 0; i < raw.length; i++) if (raw[i]) rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255;
    const warped = rectify(rgba, src.width, src.height, squared.quad, { frame: squared.frame, fill: 0 });
    if (!warped || warped.width !== out.width || warped.height !== out.height) throw new Error("warp mismatch");
    inSpace = new Uint8Array(out.width * out.height);
    for (let i = 0; i < inSpace.length; i++) inSpace[i] = warped.data[i * 4] > 127 ? 1 : 0;
    /* The target and the sheet it is printed on. The paper margin round the
       ring is part of what the model selects, so the cut is the ring plus a few
       centimetres — as a quad, because the frame follows the photo and the
       sheet usually lies at an angle to it. */
    const sheet = targetSheet(squared.frame);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of sheet) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(out.height - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(out.width - 1, Math.ceil(x1)); x++) {
        if (insideQuad(sheet, x, y)) inSpace[y * out.width + x] = 0;
      }
    }
  } else {
    inSpace = new Uint8Array(out.width * out.height);
    for (let y = 0; y < out.height; y++) {
      const sy = Math.min(src.height - 1, Math.floor((y * src.height) / out.height));
      for (let x = 0; x < out.width; x++) {
        const sx = Math.min(src.width - 1, Math.floor((x * src.width) / out.width));
        inSpace[y * out.width + x] = raw[sy * src.width + sx];
      }
    }
  }
  return finishMask(inSpace, out.width, out.height);
}
