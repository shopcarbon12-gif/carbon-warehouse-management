/**
 * Size Grading — the AI reading, on the owner's real photos, end to end.
 *
 * Same prompt (ai-prompt.ts), same grid (ai-grid.ts), same snapping
 * (ai-lines.ts) as the app; the only difference is that this calls OpenAI
 * directly instead of through /api/inventory/size-grading/ai-read. It costs
 * a few cents a run, so it is not part of the default suite:
 *
 *   OPENAI_API_KEY=… npx tsx scripts/test-size-grading-ai.ts
 *
 * There is no tape measurement of these leggings yet, so the checks are: the
 * AI finds the garment, every width line lies across the garment, and two
 * photos of the SAME pair on different surfaces agree.
 */
import fs from "node:fs";
import OpenAI from "openai";
// pngjs ships no types; these are the two calls the test makes.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require("pngjs") as {
  PNG: {
    sync: {
      read(b: Buffer): { width: number; height: number; data: Buffer };
      write(p: { width: number; height: number; data: Buffer }): Buffer;
    };
  };
};
import { detectTarget, rectify } from "@/lib/size-grading/target";
import { buildAiPrompt } from "@/lib/size-grading/ai-prompt";
import { drawAiGrid } from "@/lib/size-grading/ai-grid";
import { type AiReading } from "@/lib/size-grading/ai-lines";
import { aiKeysFor, chooseWithAi, mergeLines } from "@/lib/size-grading/ai-client";
import { findGarment, type Runner } from "@/lib/size-grading/find-garment";
import { measureGarment, pomsFor } from "@/lib/size-grading/garment";
import path from "node:path";
import { pathToFileURL } from "node:url";

let quickRunner: Runner | null = null;
async function runner(): Promise<Runner> {
  if (quickRunner) return quickRunner;
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(path.resolve("node_modules/onnxruntime-web/dist") + "/").href;
  const u2 = await ort.InferenceSession.create(new Uint8Array(fs.readFileSync("public/size-grading/model/u2netp.onnx")));
  const no = () => Promise.reject(new Error("quick only"));
  quickRunner = {
    async salience(input) {
      const out = await u2.run({ [u2.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, 320, 320]) });
      return out[u2.outputNames[0]].data as Float32Array;
    },
    samEncode: no,
    samDecode: no,
  };
  return quickRunner;
}

const FIXTURES = [
  "scripts/fixtures/size-grading/leggings-dark-table.png",
  // Cropped from a screenshot of the app; its old lines are burned in.
  "scripts/fixtures/size-grading/leggings-cutting-table-screenshot.png",
];
const WIDTHS = ["waist", "hip", "thigh", "knee", "calf", "legOpening"];

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(42)} ${detail}`);
  if (!ok) failed++;
};

async function read(client: OpenAI, file: string) {
  console.log(`\n${file.split("/").pop()}`);
  const png = PNG.sync.read(fs.readFileSync(file));
  const src = new Uint8ClampedArray(png.data);
  const det = detectTarget(src, png.width, png.height);
  if (!det) { check("target found", false); return null; }
  const rect = rectify(src, png.width, png.height, det.quad, { maxPx: 1400, upright: true })!;
  const gridded = drawAiGrid(rect.data, rect.width, rect.height);
  const image = `data:image/png;base64,${PNG.sync.write({ width: rect.width, height: rect.height, data: Buffer.from(gridded) }).toString("base64")}`;
  const runQuick = () =>
    findGarment(quickRunner!, { src: { data: src, width: png.width, height: png.height }, picture: rect.data, quad: det.quad, frame: rect.frame, quickOnly: true });
  await runner();
  // As the app: the phone first; the AI only when its cut-out fails its checks.
  const quick = await runQuick();
  const needsAi = !(quick.mask && !quick.rejected);
  check(needsAi ? "the phone's cut-out is rejected → AI" : "the phone finds it alone → no AI call", true,
    needsAi ? (quick.mask ? quick.rejected ?? "" : quick.why) : `${Math.round(quick.cm2)} cm²`);
  let ai: AiReading = { garment: "trousers", on: [], off: [], lines: {} };
  let chosen: { mask: typeof quick.mask; how: string; lines: Record<string, { a: { x: number; y: number }; b: { x: number; y: number } }> } =
    { mask: quick.mask, how: "phone only", lines: {} };
  if (needsAi) {
    const keys = aiKeysFor("trousers", "front", pomsFor("trousers", "front"));
    const t = Date.now();
    // LOAD reuses a saved reading, to work on the snapping without new AI calls.
    const saved = process.env.LOAD ? `${process.env.LOAD}-${file.split("/").pop()}.json` : "";
    const model = process.env.SIZE_GRADING_AI_MODEL || "gpt-5.4";
    const reply = saved && fs.existsSync(saved) ? { output_text: fs.readFileSync(saved, "utf8") } : await client.responses.create({
      model,
      reasoning: { effort: (process.env.EFFORT || "none") as "none" },
      text: { format: { type: "json_object" } },
      input: [{ role: "user", content: [
        { type: "input_text", text: buildAiPrompt(keys, "trousers", "front") },
        { type: "input_image", image_url: image, detail: (process.env.DETAIL || "high") as "high" },
      ] }],
    });
    if ("usage" in reply && reply.usage) {
      const u = reply.usage;
      // $ per million tokens, in / out (OpenAI list prices, October 2026).
      const PRICE: Record<string, [number, number]> = { "gpt-5.5": [5, 30], "gpt-5.4": [2.5, 15], "gpt-5.4-mini": [0.75, 4.5] };
      const [pi, po] = PRICE[model] ?? [5, 30];
      console.log(`  cost: ${u.input_tokens} in + ${u.output_tokens} out = ${((u.input_tokens * pi + u.output_tokens * po) / 1e4).toFixed(2)}¢`);
    }
    ai = JSON.parse(reply.output_text) as AiReading;
    if (process.env.DUMP) fs.writeFileSync(`${process.env.DUMP}-${file.split("/").pop()}.json`, JSON.stringify(ai));
    check("the AI reads it as trousers", ai.garment === "trousers", `${ai.description ?? ""} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    chosen = chooseWithAi(ai, quick.mask, rect, rect.frame, { width: png.width, height: png.height }, det.quad) as typeof chosen;
    check("a cut-out holds up", !!chosen.mask, chosen.how);
    const wb = chosen.lines.waistbandHeight;
    const wbCm = wb ? Math.hypot(wb.b.x - wb.a.x, wb.b.y - wb.a.y) / rect.pxPerCm : NaN;
    check("the AI places the waistband height", wbCm >= 1.5 && wbCm <= 10, `${wbCm.toFixed(1)} cm`);
  }
  const res = chosen.mask ? measureGarment(chosen.mask, rect.pxPerCm, "trousers") : null;
  const lines = mergeLines(res?.ok ? res.points : null, chosen.lines) as Record<string, { a: { x: number; y: number }; b: { x: number; y: number } }>;
  const cm: Record<string, number> = {};
  for (const [k, s] of Object.entries(lines)) cm[k] = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) / rect.pxPerCm;

  if (process.env.DUMP) {
    // Snapped lines in yellow, the AI's own in cyan — for looking, not for checking.
    const vis = Buffer.from(rect.data);
    const draw = (a: { x: number; y: number }, b: { x: number; y: number }, c: number[]) => {
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 0; t <= L; t++) {
        const x = Math.round(a.x + ((b.x - a.x) * t) / L), y = Math.round(a.y + ((b.y - a.y) * t) / L);
        for (let d = -1; d <= 1; d++) { const o = ((y + d) * rect.width + x) * 4; vis[o] = c[0]; vis[o + 1] = c[1]; vis[o + 2] = c[2]; }
      }
    };
    const P = ([x, y]: [number, number]) => ({ x: (x / 1000) * rect.width, y: (y / 1000) * rect.height });
    for (const l of Object.values(ai.lines)) if (l) draw(P(l.a), P(l.b), [0, 255, 255]);
    for (const s of Object.values(lines)) if (s) draw(s.a, s.b, [255, 220, 0]);
    fs.writeFileSync(`${process.env.DUMP}-${file.split("/").pop()}`, PNG.sync.write({ width: rect.width, height: rect.height, data: vis }));
  }

  /* Each width line must lie across the garment: dark leggings, so most of the
     pixels along it are dark. A line on the table or the paper is not. 75 %,
     not more: lit folds read lighter than the bar, and on the screenshot
     fixture the app's old waist line is burned into the waistband. */
  for (const k of WIDTHS) {
    const s = lines[k];
    if (!s) { check(`${k} placed`, false); continue; }
    const n = 50;
    let dark = 0;
    for (let i = 1; i < n; i++) {
      const x = Math.round(s.a.x + ((s.b.x - s.a.x) * i) / n), y = Math.round(s.a.y + ((s.b.y - s.a.y) * i) / n);
      const o = (y * rect.width + x) * 4;
      if (rect.data[o] + rect.data[o + 1] + rect.data[o + 2] < 3 * 70) dark++;
    }
    check(`${k} lies across the garment`, dark / (n - 1) >= 0.75, `${cm[k].toFixed(1)} cm, ${Math.round((100 * dark) / (n - 1))}% on fabric`);
  }
  return cm;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.log("OPENAI_API_KEY not set — skipped"); return; }
  const client = new OpenAI({ apiKey });
  // One after the other, so each photo's lines print together.
  const a = await read(client, FIXTURES[0]);
  const b = await read(client, FIXTURES[1]);
  if (!a || !b) return;
  console.log("\nthe same leggings on two different tables");
  for (const [k, tol] of [["waist", 2.5], ["hip", 3], ["thigh", 2], ["knee", 2], ["calf", 2], ["legOpening", 2.5], ["inseam", 4], ["outseam", 4]] as const) {
    check(`${k} agrees (±${tol} cm)`, Math.abs((a[k] ?? NaN) - (b[k] ?? NaN)) <= tol, `${a[k]?.toFixed(1)} vs ${b[k]?.toFixed(1)}`);
  }
}

main()
  .catch((e) => { console.log("  FAIL  could not run:", e instanceof Error ? e.message : e); failed++; })
  .then(() => { console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed"); process.exit(failed ? 1 : 0); });
