/**
 * Copy the ONNX runtime's wasm into public/ort/, where the browser loads it.
 *
 * Copied from node_modules at build time rather than committed, because the
 * runtime's JavaScript and its .wasm must be the SAME version — a committed copy
 * goes stale on the next `npm update` and fails to initialise with an error
 * that does not mention versions at all. The Dockerfile runs this before
 * `next build`; run it yourself (`npm run ort:copy`) for local dev.
 */
import fs from "node:fs";
import path from "node:path";

const src = path.join("node_modules", "onnxruntime-web", "dist");
const dst = path.join("public", "ort");
fs.mkdirSync(dst, { recursive: true });
for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
  fs.copyFileSync(path.join(src, f), path.join(dst, f));
  console.log(`ort: ${f} → public/ort/ (${Math.round(fs.statSync(path.join(dst, f)).size / 1024)} KB)`);
}
