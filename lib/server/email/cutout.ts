/**
 * CarbonWMS Email — "Cut out the background" for hero photos (owner's CARBON pack: heroes 03, 04,
 * 12, 17, 25, 35 put a cut-out model or product ON the type; "needs a bg-removal step").
 *
 * Runs the same U²-Netp salient-object model Size Grading uses (public/size-grading/model/u2netp.onnx,
 * onnxruntime-web's wasm runtime from public/ort), here on the server: no outside service, no cost
 * per photo. The model's soft mask (scaled up smoothly, edges feathered) becomes the PNG's
 * transparency; the result is saved as an upload and used in place of the photo.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import type { Pool } from "pg";
import { modelInput, MODEL_INPUT_SIZE } from "@/lib/size-grading/model-segment";
import { uploadImage, type LibraryImage } from "./editor";

type Session = { inputNames: readonly string[]; outputNames: readonly string[]; run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: unknown }>> };
let session: Promise<{ s: Session; Tensor: new (t: "float32", d: Float32Array, dims: number[]) => unknown }> | null = null;

function load() {
  session ??= (async () => {
    const ort = await import("onnxruntime-web/wasm");
    ort.env.wasm.wasmPaths = pathToFileURL(path.join(process.cwd(), "public/ort") + "/").href;
    ort.env.wasm.numThreads = 1;
    const model = fs.readFileSync(path.join(process.cwd(), "public/size-grading/model/u2netp.onnx"));
    const s = (await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] })) as unknown as Session;
    return { s, Tensor: ort.Tensor as unknown as new (t: "float32", d: Float32Array, dims: number[]) => unknown };
  })().catch((e) => {
    session = null;
    throw e;
  });
  return session;
}

/** Only pictures from the shop's CDN or CarbonWMS itself (never an arbitrary address). */
export function allowedPhotoUrl(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && (x.hostname === "cdn.shopify.com" || x.hostname === "wms.shopcarbon.com" || x.hostname === "shopcarbon.com");
  } catch {
    return false;
  }
}

/** The photo with its background made transparent (PNG, at most 1200 px wide). */
export async function cutoutPng(photo: Buffer): Promise<Buffer> {
  const img = sharp(photo).rotate().resize({ width: 1200, height: 1600, fit: "inside", withoutEnlargement: true }).removeAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  // modelInput wants RGBA
  const rgba = new Uint8ClampedArray(info.width * info.height * 4);
  for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
    rgba[j] = data[i];
    rgba[j + 1] = data[i + 1];
    rgba[j + 2] = data[i + 2];
    rgba[j + 3] = 255;
  }
  const { s, Tensor } = await load();
  const S = MODEL_INPUT_SIZE;
  const out = await s.run({ [s.inputNames[0]]: new Tensor("float32", modelInput(rgba, info.width, info.height), [1, 3, S, S]) });
  const probs = out[s.outputNames[0]].data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < S * S; i++) {
    if (probs[i] < lo) lo = probs[i];
    if (probs[i] > hi) hi = probs[i];
  }
  const span = Math.max(1e-6, hi - lo);
  // Soft mask: a gentle curve keeps the subject solid and the background clear.
  const mask = Buffer.alloc(S * S);
  for (let i = 0; i < S * S; i++) {
    const v = (probs[i] - lo) / span;
    mask[i] = Math.round(255 * Math.min(1, Math.max(0, (v - 0.15) / 0.55)));
  }
  // One channel out (sharp would otherwise hand back three and the alpha would be read out of step).
  const alpha = await sharp(mask, { raw: { width: S, height: S, channels: 1 } }).resize(info.width, info.height, { kernel: "cubic" }).blur(0.6).extractChannel(0).raw().toBuffer();
  const W = info.width;
  const H = info.height;
  // The model's mask is coarse (320 px) and fat around the subject. On a studio backdrop the colour
  // is the better guide: the backdrop is read from the photo's border, then filled inward through every
  // connected backdrop-like pixel (light, nearly colourless, close to that colour). What the fill
  // reaches is background; what it cannot reach — the subject, including white clothes surrounded by
  // the subject's own outline — stays, limited to the model's mask so stray light patches go too.
  const border: number[] = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) border.push(y * W, y * W + W - 1);
  const ch = (c: number) => border.map((i) => data[i * 3 + c]).sort((a, b) => a - b)[Math.floor(border.length / 2)];
  const bg = [ch(0), ch(1), ch(2)];
  const bgLight = Math.min(bg[0], bg[1], bg[2]);
  const bgLike = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const r = data[i * 3];
    const g = data[i * 3 + 1];
    const b = data[i * 3 + 2];
    const light = Math.min(r, g, b);
    const chroma = Math.max(r, g, b) - light;
    const d = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
    bgLike[i] = (chroma < 24 && light >= bgLight - 30) || d < 18 ? 1 : 0;
  }
  const reached = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  for (const i of border) if (bgLike[i] && !reached[i]) (reached[i] = 1), (queue[tail++] = i);
  while (head < tail) {
    const i = queue[head++];
    const x = i % W;
    const n = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
    for (const k of n) if (k >= 0 && k < W * H && !reached[k] && bgLike[k]) (reached[k] = 1), (queue[tail++] = k);
  }
  // Backdrop shut in by the subject (between an arm and the body): a patch of backdrop-like pixels
  // the fill could not reach that is, on average, practically the backdrop colour itself. White
  // clothes have shading and stay.
  const seen = new Uint8Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (!bgLike[start] || reached[start] || seen[start]) continue;
    head = 0;
    tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let sum = 0;
    while (head < tail) {
      const i = queue[head++];
      sum += Math.hypot(data[i * 3] - bg[0], data[i * 3 + 1] - bg[1], data[i * 3 + 2] - bg[2]);
      const x = i % W;
      const n = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W];
      for (const k of n) if (k >= 0 && k < W * H && !seen[k] && !reached[k] && bgLike[k]) (seen[k] = 1), (queue[tail++] = k);
    }
    if (tail >= 150 && sum / tail < 9) for (let q = 0; q < tail; q++) reached[queue[q]] = 1;
  }
  const finalA = Buffer.alloc(W * H);
  for (let i = 0; i < W * H; i++) finalA[i] = reached[i] ? 0 : alpha[i] > 25 ? 255 : 0;
  const soft = await sharp(finalA, { raw: { width: W, height: H, channels: 1 } }).blur(0.5).extractChannel(0).raw().toBuffer();
  return sharp(data, { raw: { width: W, height: H, channels: 3 } }).joinChannel(soft, { raw: { width: W, height: H, channels: 1 } }).png({ compressionLevel: 9 }).toBuffer();
}

export async function cutoutFromUrl(pool: Pool, tenantId: string, by: string | null, url: string): Promise<LibraryImage> {
  if (!allowedPhotoUrl(url)) throw new Error("Use a photo from the picture library or your Shopify products");
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`Could not load the photo (${r.status})`);
  const bytes = Buffer.from(await r.arrayBuffer());
  if (bytes.length > 25 * 1024 * 1024) throw new Error("The photo is too big");
  const png = await cutoutPng(bytes);
  const base = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "photo").replace(/\.[a-z0-9]+$/i, "");
  return uploadImage(pool, tenantId, by, { name: `${base} (cut out).png`, bytes: png });
}
