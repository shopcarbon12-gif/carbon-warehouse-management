/**
 * The coordinate grid the vision model reads positions off.
 *
 * Drawn into the pixels rather than described in words: asked for positions
 * on a bare photo a model drifts by several percent, while with labelled lines
 * every 10 % it reads them off like a map. Pure RGBA, with its own digit font,
 * so the phone and the tests send the model exactly the same picture.
 */
import { AI_GRID_STEP } from "./ai-prompt";

// 3×5 digits, rows top to bottom, 3 bits each.
const DIGITS: Record<string, number[]> = {
  "0": [7, 5, 5, 5, 7], "1": [2, 6, 2, 2, 7], "2": [7, 1, 7, 4, 7], "3": [7, 1, 7, 1, 7],
  "4": [5, 5, 7, 1, 1], "5": [7, 4, 7, 1, 7], "6": [7, 4, 7, 5, 7], "7": [7, 1, 1, 1, 1],
  "8": [7, 5, 7, 5, 7], "9": [7, 5, 7, 1, 7],
};
const INK: [number, number, number] = [255, 0, 255];

function put(px: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: [number, number, number]) {
  if (x < 0 || y < 0 || x >= w || y >= h) return;
  const i = (y * w + x) * 4;
  px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
}

function text(px: Uint8ClampedArray, w: number, h: number, s: string, x0: number, y0: number, scale: number) {
  let x = x0;
  for (const ch of s) {
    const rows = DIGITS[ch];
    if (!rows) continue;
    // A dark halo so the label reads on white paper and on a black garment.
    for (let r = -1; r <= 5; r++) {
      for (let c = -1; c <= 3; c++) {
        const on = r >= 0 && r < 5 && c >= 0 && c < 3 && (rows[r] >> (2 - c)) & 1;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            put(px, w, h, x + c * scale + dx, y0 + r * scale + dy, on ? INK : [0, 0, 0]);
          }
        }
      }
    }
    x += 4 * scale;
  }
}

/** A copy of the picture with the 0–1000 grid drawn over it. */
export function drawAiGrid(src: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(src);
  const scale = Math.max(2, Math.round(Math.max(w, h) / 400));
  for (let v = 0; v <= 1000; v += AI_GRID_STEP) {
    const x = Math.min(w - 1, Math.round((v / 1000) * w));
    const y = Math.min(h - 1, Math.round((v / 1000) * h));
    for (let yy = 0; yy < h; yy++) put(px, w, h, x, yy, INK);
    for (let xx = 0; xx < w; xx++) put(px, w, h, xx, y, INK);
  }
  for (let v = 0; v < 1000; v += AI_GRID_STEP) {
    const x = Math.round((v / 1000) * w), y = Math.round((v / 1000) * h);
    text(px, w, h, String(v), x + scale * 2, scale * 2, scale);
    if (v) text(px, w, h, String(v), scale * 2, y + scale * 2, scale);
  }
  return px;
}
