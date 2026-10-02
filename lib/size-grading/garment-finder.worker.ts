/**
 * The garment finder, off the main thread.
 *
 * The segment-anything pass is ~25 s of solid compute on a phone. On the main
 * thread that is a frozen page — no spinner, no scrolling, and Android offering
 * to kill the tab. Here it is just a wait with the page still alive.
 */
import { findGarment, type FindInput, type Runner } from "./find-garment";

type Ort = typeof import("onnxruntime-web/wasm");
type Session = import("onnxruntime-web/wasm").InferenceSession;

const origin = self.location.origin;
let ortP: Promise<Ort> | null = null;
const sessions = new Map<string, Promise<Session>>();

function ort(): Promise<Ort> {
  ortP ??= import("onnxruntime-web/wasm").then((o) => {
    /* The wasm-only entry and our own copy of its runtime — see
       model-segment.ts for the 27 MB WebGPU trap. Absolute, because a worker
       resolves relative paths against its own script under /_next/. */
    o.env.wasm.wasmPaths = `${origin}/ort/`;
    o.env.wasm.numThreads = 1;
    return o;
  });
  return ortP;
}

function session(file: string): Promise<Session> {
  let s = sessions.get(file);
  if (!s) {
    s = ort().then((o) =>
      o.InferenceSession.create(`${origin}/size-grading/model/${file}`, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      }),
    );
    // A failed download must not poison every later photo.
    s.catch(() => sessions.delete(file));
    sessions.set(file, s);
  }
  return s;
}

const runner: Runner = {
  async salience(input) {
    const o = await ort();
    const s = await session("u2netp.onnx");
    const out = await s.run({ [s.inputNames[0]]: new o.Tensor("float32", input, [1, 3, 320, 320]) });
    return out[s.outputNames[0]].data as Float32Array;
  },
  async samEncode(pixels) {
    const o = await ort();
    const s = await session("slimsam-encoder.onnx");
    return s.run({ pixel_values: new o.Tensor("float32", pixels, [1, 3, 1024, 1024]) });
  },
  async samDecode(embedding, points, n) {
    const o = await ort();
    const s = await session("slimsam-decoder.onnx");
    const e = embedding as Record<string, import("onnxruntime-web/wasm").Tensor>;
    const out = await s.run({
      input_points: new o.Tensor("float32", points, [1, n, 1, 2]),
      input_labels: new o.Tensor("int64", new BigInt64Array(n).fill(BigInt(1)), [1, n, 1]),
      image_embeddings: e.image_embeddings,
      image_positional_embeddings: e.image_positional_embeddings,
    });
    return { iou: out.iou_scores.data as Float32Array, masks: out.pred_masks.data as Float32Array };
  },
};

self.onmessage = async (ev: MessageEvent<{ id: number; warm?: boolean; input?: FindInput }>) => {
  const { id, warm, input } = ev.data;
  if (warm) {
    void session("u2netp.onnx").catch(() => {});
    return;
  }
  if (!input) return;
  try {
    const result = await findGarment(runner, input, (stage) => self.postMessage({ id, stage }));
    self.postMessage({ id, result });
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
