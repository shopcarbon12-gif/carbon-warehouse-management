/**
 * Size Grading — a REAL photo, end to end, through the code that ships.
 *
 * Every other size-grading test draws a synthetic scene, and every one of them
 * passed while the app failed on the owner's actual photos: the target printed
 * grey and was never found; the garment model was fed a squared-up image whose
 * white fill made the whole photo look like one object; a waistband lying a few
 * degrees off clipped the measuring row. None of that is visible in a scene
 * drawn to be clean. This test is the owner's own photo of a pair of Ella
 * leggings on the warehouse table, run through detection, squaring up, the
 * on-device model (onnxruntime-web, the same runtime the browser uses), the
 * mask warp and the measurement — all imported from lib/, nothing copied.
 *
 * The bounds are deliberately plausibility checks, not exact values: no tape
 * measurement of this garment exists yet. When the owner measures it, tighten
 * TAPE below to the real numbers and this becomes an accuracy test.
 *
 *   npx tsx scripts/test-size-grading-photo.ts
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
// pngjs ships no types; this is the one call the test makes.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PNG } = require("pngjs") as { PNG: { sync: { read(b: Buffer): { width: number; height: number; data: Buffer } } } };

import { detectTarget, rectify } from "@/lib/size-grading/target";
import { MODEL_INPUT_SIZE, maskForMeasuring, modelInput, modelOutputToMask } from "@/lib/size-grading/model-segment";
import { measureGarment, pomsFor, POM_SOURCE } from "@/lib/size-grading/garment";

const FIXTURE = "scripts/fixtures/size-grading/leggings-dark-table.png";
const AROUND_CM = 60; // must match the workspace

/** Plausible ranges for a women's size S legging, flat. Replace with tape values. */
const TAPE: Record<string, [number, number]> = {
  waist: [22, 34],
  hip: [30, 44],
  outseam: [85, 105],
  inseam: [50, 80],
  rise: [20, 42],
  legOpening: [7, 14],
};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(44)} ${detail}`);
  if (!ok) failed++;
};

async function main() {
  const png = PNG.sync.read(fs.readFileSync(FIXTURE));
  const src = { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };

  // 1. The target, printed grey on a dark table.
  const det = detectTarget(src.data, src.width, src.height);
  check("the printed target is found", !!det, det ? `confidence ${det.confidence.toFixed(2)}` : "");
  if (!det) return;

  const rect = rectify(src.data, src.width, src.height, det.quad, { maxPx: 1400, aroundCm: AROUND_CM });
  if (!rect) return check("the photo squares up", false);
  // By construction the target is now exactly 18 x 24 cm; this guards the maths.
  check("photo squared up", rect.pxPerCm > 3, `${rect.pxPerCm.toFixed(2)} px/cm`);

  // 2. The model, on the PHOTO, through the browser's own runtime.
  const ort = await import("onnxruntime-web/wasm");
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = pathToFileURL(path.resolve("node_modules/onnxruntime-web/dist") + "/").href;
  const session = await ort.InferenceSession.create(
    new Uint8Array(fs.readFileSync("public/size-grading/model/u2netp.onnx")),
    { executionProviders: ["wasm"] },
  );
  const S = MODEL_INPUT_SIZE;
  const out = await session.run({
    [session.inputNames[0]]: new ort.Tensor("float32", modelInput(src.data, src.width, src.height), [1, 3, S, S]),
  });
  const raw = modelOutputToMask(out[session.outputNames[0]].data as Float32Array, src.width, src.height);
  const mask = maskForMeasuring(raw, src, rect, { quad: det.quad, pxPerCm: rect.pxPerCm, aroundCm: AROUND_CM });

  /* The failure this is guarding: the model selecting the table, which is most
     of the frame. Leggings are a few thousand square centimetres. */
  const cm2 = mask.area / rect.pxPerCm ** 2;
  check("the garment, not the table, is selected", cm2 > 1200 && cm2 < 4500, `${cm2.toFixed(0)} cm²`);

  // 3. Measure — the catalogue says these are leggings.
  const res = measureGarment(mask, rect.pxPerCm, "trousers");
  check("the leggings measure", res.ok, res.ok ? "" : res.error);
  if (!res.ok) return;

  const camera = pomsFor("trousers", "front").filter((k) => POM_SOURCE[k] === "camera");
  const missing = camera.filter((k) => !res.points[k]);
  check("every camera point is produced", !missing.length, missing.length ? `missing ${missing.join(", ")}` : `${camera.length} points`);

  for (const [k, [lo, hi]] of Object.entries(TAPE)) {
    const cm = res.points[k as keyof typeof res.points]?.cm;
    check(`${k} is plausible (${lo}–${hi} cm)`, cm !== undefined && cm >= lo && cm <= hi, cm !== undefined ? `${cm.toFixed(1)} cm` : "missing");
  }

  // A leg narrows from thigh to hem; a measurement that does not is on the table.
  const w = (k: string) => res.points[k as keyof typeof res.points]?.cm ?? NaN;
  check("the leg narrows thigh → knee → calf → opening",
    w("thigh") > w("knee") && w("knee") > w("calf") && w("calf") > w("legOpening"),
    `${w("thigh").toFixed(1)} > ${w("knee").toFixed(1)} > ${w("calf").toFixed(1)} > ${w("legOpening").toFixed(1)}`);

  /* Every line sits ON the garment. The middle of each one must be garment, not
     table: an inseam drawn across the gap between the legs, or an outseam down
     the middle, both used to fail this while reporting a plausible number. */
  const off: string[] = [];
  for (const [k, p] of Object.entries(res.points)) {
    if (!p) continue;
    const mx = Math.round((p.line.a.x + p.line.b.x) / 2);
    const my = Math.round((p.line.a.y + p.line.b.y) / 2);
    // Allow a couple of pixels: a line along an edge sits on the boundary.
    let hit = false;
    for (let dy = -3; dy <= 3 && !hit; dy++) for (let dx = -3; dx <= 3 && !hit; dx++) {
      const x = mx + dx, y = my + dy;
      if (x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.data[y * mask.width + x]) hit = true;
    }
    if (!hit) off.push(k);
  }
  check("every line lies on the garment", !off.length, off.length ? `off: ${off.join(", ")}` : "");
}

main()
  .catch((e) => {
    console.log("  FAIL  the test could not run:", e instanceof Error ? e.message : e);
    failed++;
  })
  .then(() => {
    console.log(failed ? `\n${failed} check${failed === 1 ? "" : "s"} FAILED` : "\nall checks passed");
    process.exit(failed ? 1 : 0);
  });
