/**
 * Square ad picture for Meta's catalog cards (owner 2026-10-22). The whole
 * photo is kept — never cropped — and widened to a square with its own
 * backdrop at the sides, so a 4:5 close-up fills the card's height instead of
 * a full-length photo shrunk into Shopify's white square.
 *
 * The side fill is one colour per row (no sideways streaks): the backdrop at
 * that row's outer edge, or the corners' backdrop where the model reaches the
 * edge, smoothed top to bottom so it follows the studio's light falloff.
 */
import sharp from "sharp";

export const AD_SQUARE = 1080;
/** Width of the edge strip read per row, and of the blend into the photo. */
const EDGE = 6;
const BLEND = 14;

export async function adSquare(photo: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(photo)
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize(AD_SQUARE, AD_SQUARE, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, S = AD_SQUARE;
  if (w >= S) return sharp(data, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();

  const px = (x: number, y: number, c: number) => data[(y * w + x) * 3 + c];
  // Backdrop reference: median of the four corner patches.
  const cs = Math.max(4, Math.round(Math.min(w, h) * 0.03));
  const corner: number[][] = [[], [], []];
  for (const [x0, y0] of [[0, 0], [w - cs, 0], [0, h - cs], [w - cs, h - cs]])
    for (let y = y0; y < y0 + cs; y++) for (let x = x0; x < x0 + cs; x++) for (let c = 0; c < 3; c++) corner[c].push(px(x, y, c));
  const ref = corner.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);

  // Per side and row: the outer strip's mean when it looks like backdrop, else the reference.
  const sideRows = (x0: number) => {
    const rows = new Float32Array(h * 3);
    for (let y = 0; y < h; y++) {
      const m = [0, 0, 0];
      for (let x = x0; x < x0 + EDGE; x++) for (let c = 0; c < 3; c++) m[c] += px(x, y, c) / EDGE;
      const near = Math.abs(m[0] - ref[0]) + Math.abs(m[1] - ref[1]) + Math.abs(m[2] - ref[2]) < 45;
      for (let c = 0; c < 3; c++) rows[y * 3 + c] = near ? m[c] : ref[c];
    }
    // Smooth top to bottom (box blur, three passes ≈ gaussian).
    const r = Math.max(8, Math.round(h * 0.04));
    for (let pass = 0; pass < 3; pass++)
      for (let c = 0; c < 3; c++) {
        const src = Array.from({ length: h }, (_, y) => rows[y * 3 + c]);
        for (let y = 0; y < h; y++) {
          let s = 0, n = 0;
          for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += src[k]; n++; }
          rows[y * 3 + c] = s / n;
        }
      }
    return rows;
  };
  const leftRows = sideRows(0), rightRows = sideRows(w - EDGE);

  const ox = Math.floor((S - w) / 2), oy = Math.floor((S - h) / 2);
  const out = Buffer.alloc(S * S * 3);
  for (let y = 0; y < S; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - oy));
    for (let x = 0; x < S; x++) {
      const sx = x - ox;
      const fill = sx < w / 2 ? leftRows : rightRows;
      for (let c = 0; c < 3; c++) {
        const f = fill[sy * 3 + c];
        let v: number;
        if (sx < 0 || sx >= w || y < oy || y >= oy + h) v = f;
        else {
          // Blend the photo's outer BLEND px into the fill so the join never shows as a line.
          const d = Math.min(sx, w - 1 - sx);
          const t = d >= BLEND ? 1 : d / BLEND;
          v = px(sx, y - oy, c) * t + f * (1 - t);
        }
        out[(y * S + x) * 3 + c] = Math.round(v);
      }
    }
  }
  return sharp(out, { raw: { width: S, height: S, channels: 3 } }).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
}
