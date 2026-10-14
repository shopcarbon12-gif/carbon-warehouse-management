import sharp from "sharp";

/**
 * The jeans label, placed from the operator's photo instead of drawn.
 *
 * Attached as a reference, the label still came back re-lettered ("CARRON
 * JEANS", "CARBON JEAN") and different in each pose: an image model redraws a
 * small patch, it does not copy it. So the renderer is told to leave a flat
 * key-colour shape where the label sits (Pose 7), and this module finds that
 * shape and paints the real photo into it — every letter is the photograph's.
 */

export type LabelKey = { name: string; hex: string; hi: number[]; lo: number[] };

const MAGENTA: LabelKey = { name: "magenta", hex: "#FF00FF", hi: [0, 2], lo: [1] };
const GREEN: LabelKey = { name: "green", hex: "#00FF00", hi: [1], lo: [0, 2] };

const MAGENTA_WORDS = /\b(magenta|fuchsia|hot[\s-]?pink|purple|violet|plum|orchid|berry|mauve)\b/i;
const GREEN_WORDS = /\b(green|lime|neon|olive|mint|emerald|chartreuse|sage|khaki)\b/i;

/** A key colour nothing in this shoot is meant to wear; null when neither is safe. */
export function pickLabelKey(shootText: string): LabelKey | null {
  if (!MAGENTA_WORDS.test(shootText)) return MAGENTA;
  if (!GREEN_WORDS.test(shootText)) return GREEN;
  return null;
}

/** Upright label photo (EXIF applied) and its width / height. */
export async function readLabelPhoto(bytes: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(bytes).autoOrient().png().toBuffer({ resolveWithObject: true });
  return { png: data, width: info.width, height: info.height };
}

/** "about 2.4 times as wide as it is tall" — the outline the renderer leaves. */
export function labelProportions(width: number, height: number): string {
  const r = width / Math.max(1, height);
  if (r >= 1.15) return `about ${r.toFixed(1)} times as wide as it is tall`;
  if (r <= 0.87) return `about ${(1 / r).toFixed(1)} times as tall as it is wide`;
  return "about as tall as it is wide";
}

function keyScores(d: Buffer, i: number, key: LabelKey) {
  let hiMin = 255;
  let hiMax = 0;
  let loMax = 0;
  for (const c of key.hi) {
    const v = d[i + c];
    if (v < hiMin) hiMin = v;
    if (v > hiMax) hiMax = v;
  }
  for (const c of key.lo) if (d[i + c] > loMax) loMax = d[i + c];
  return { hiMin, hiMax, loMax };
}

function isCore(d: Buffer, i: number, key: LabelKey) {
  const { hiMin, hiMax, loMax } = keyScores(d, i, key);
  return hiMin >= 90 && loMax <= 0.45 * hiMin && hiMax - hiMin <= 0.3 * hiMax;
}

/** Anti-aliased edge of the key shape: still clearly tinted, not the cloth. */
function isFringe(d: Buffer, i: number, key: LabelKey) {
  const { hiMin, hiMax, loMax } = keyScores(d, i, key);
  return hiMin - loMax >= 25 && hiMax - hiMin <= 0.45 * Math.max(1, hiMax);
}

export type LabelCompositeResult = {
  b64: string;
  /** Key shapes the label was painted into (0 = the renderer drew none). */
  placed: number;
  /** Key-colour pixels still in the image afterwards. */
  keyPixelsLeft: number;
};

/**
 * Finds each flat key-colour shape in the render and paints the label photo
 * into it: lined up with the shape (its long side along the shape's, kept
 * reading left to right), sized to it, lit by the shape's own shading, and
 * covering its tinted edge. Lettering the renderer drew on the shape anyway is
 * covered too (holes are filled); anything crossing its outer edge stays.
 */
export async function compositeLabelIntoKey(args: {
  imageB64: string;
  label: { png: Buffer; width: number; height: number };
  key: LabelKey;
}): Promise<LabelCompositeResult> {
  const input = Buffer.from(args.imageB64, "base64");
  const meta = await sharp(input).metadata();
  const { data, info } = await sharp(input).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const n = w * h;
  const key = args.key;

  const core = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (isCore(data, p * ch, key)) core[p] = 1;

  /* Connected shapes (4-neighbour). A label is a small patch: tiny specks and
     anything the size of a garment are not it. */
  const minArea = Math.max(120, Math.round(n * 0.00008));
  const maxArea = Math.round(n * 0.04);
  const comp = new Int32Array(n);
  const stack = new Int32Array(n);
  const shapes: Array<{ x0: number; y0: number; x1: number; y1: number; area: number; id: number }> = [];
  let nextId = 0;
  for (let p = 0; p < n; p++) {
    if (!core[p] || comp[p]) continue;
    const id = ++nextId;
    let top = 0;
    stack[top++] = p;
    comp[p] = id;
    let area = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (top) {
      const q = stack[--top];
      area++;
      const x = q % w;
      const y = (q / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && core[q - 1] && !comp[q - 1]) { comp[q - 1] = id; stack[top++] = q - 1; }
      if (x < w - 1 && core[q + 1] && !comp[q + 1]) { comp[q + 1] = id; stack[top++] = q + 1; }
      if (y > 0 && core[q - w] && !comp[q - w]) { comp[q - w] = id; stack[top++] = q - w; }
      if (y < h - 1 && core[q + w] && !comp[q + w]) { comp[q + w] = id; stack[top++] = q + w; }
    }
    if (area >= minArea && area <= maxArea) shapes.push({ x0, y0, x1, y1, area, id });
  }

  let placed = 0;
  const out = Buffer.from(data);
  for (const s of shapes) {
    /* The shape with its holes filled (letters drawn on it), in a padded box. */
    const pad = 3;
    const bx0 = Math.max(0, s.x0 - pad);
    const by0 = Math.max(0, s.y0 - pad);
    const bx1 = Math.min(w - 1, s.x1 + pad);
    const by1 = Math.min(h - 1, s.y1 + pad);
    const bw = bx1 - bx0 + 1;
    const bh = by1 - by0 + 1;
    const inShape = new Uint8Array(bw * bh);
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) if (comp[y * w + x] === s.id) inShape[(y - by0) * bw + (x - bx0)] = 1;
    const outside = new Uint8Array(bw * bh);
    let top = 0;
    const seed = (lx: number, ly: number) => {
      const k = ly * bw + lx;
      if (!inShape[k] && !outside[k]) { outside[k] = 1; stack[top++] = k; }
    };
    for (let x = 0; x < bw; x++) { seed(x, 0); seed(x, bh - 1); }
    for (let y = 0; y < bh; y++) { seed(0, y); seed(bw - 1, y); }
    while (top) {
      const k = stack[--top];
      const x = k % bw;
      const y = (k / bw) | 0;
      if (x > 0) seed(x - 1, y);
      if (x < bw - 1) seed(x + 1, y);
      if (y > 0) seed(x, y - 1);
      if (y < bh - 1) seed(x, y + 1);
    }
    const filled = new Uint8Array(bw * bh);
    let fillArea = 0;
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < bw * bh; k++) {
      if (outside[k]) continue;
      filled[k] = 1;
      fillArea++;
      sx += k % bw;
      sy += (k / bw) | 0;
    }
    const cx = sx / fillArea;
    const cy = sy / fillArea;

    /* Orientation from the shape's second moments; the label's x axis is the
       shape axis closest to horizontal, pointing right, so text reads upright. */
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let k = 0; k < bw * bh; k++) {
      if (!filled[k]) continue;
      const dx = (k % bw) - cx;
      const dy = ((k / bw) | 0) - cy;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const axes: Array<[number, number]> = [
      [Math.cos(theta), Math.sin(theta)],
      [-Math.sin(theta), Math.cos(theta)],
    ];
    let [c, sn] = axes[0];
    if (Math.abs(axes[1][0]) > Math.abs(c)) [c, sn] = axes[1];
    if (c < 0) { c = -c; sn = -sn; }

    let amin = Infinity;
    let amax = -Infinity;
    let bmin = Infinity;
    let bmax = -Infinity;
    for (let k = 0; k < bw * bh; k++) {
      if (!filled[k]) continue;
      const dx = (k % bw) - cx;
      const dy = ((k / bw) | 0) - cy;
      const a = dx * c + dy * sn;
      const b = -dx * sn + dy * c;
      if (a < amin) amin = a;
      if (a > amax) amax = a;
      if (b < bmin) bmin = b;
      if (b > bmax) bmax = b;
    }
    const rw = amax - amin + 1;
    const rh = bmax - bmin + 1;
    /* A patch is a solid, roughly four-sided shape; a sprawling tinted area is not. */
    if (fillArea / (rw * rh) < 0.6) continue;

    const lw = Math.max(2, Math.round(rw));
    const lh = Math.max(2, Math.round(rh));
    const lab = await sharp(args.label.png).resize(lw, lh, { fit: "fill" }).ensureAlpha().raw().toBuffer();

    /* The cloth around the shape, for any transparent part of the label photo. */
    const ring: number[][] = [[], [], []];
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const k = (y - by0) * bw + (x - bx0);
        if (!outside[k]) continue;
        const i = (y * w + x) * ch;
        if (isFringe(data, i, key)) continue;
        for (let j = 0; j < 3; j++) ring[j].push(data[i + j]);
      }
    }
    const median = (v: number[]) => (v.length ? v.sort((p, q) => p - q)[v.length >> 1] : 128);
    const bg = [median(ring[0]), median(ring[1]), median(ring[2])];

    /* The renderer's own light on the shape, so the label sits in the photo. */
    const lums: number[] = [];
    for (let k = 0; k < bw * bh; k++) {
      if (!filled[k]) continue;
      const i = ((by0 + ((k / bw) | 0)) * w + bx0 + (k % bw)) * ch;
      if (isCore(data, i, key)) lums.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }
    const refLum = Math.max(1, median(lums));

    const sample = (fx: number, fy: number, out4: number[]) => {
      const x = Math.min(lw - 1, Math.max(0, fx));
      const y = Math.min(lh - 1, Math.max(0, fy));
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(lw - 1, x0 + 1);
      const y1 = Math.min(lh - 1, y0 + 1);
      const tx = x - x0;
      const ty = y - y0;
      for (let j = 0; j < 4; j++) {
        const a = lab[(y0 * lw + x0) * 4 + j] * (1 - tx) + lab[(y0 * lw + x1) * 4 + j] * tx;
        const b = lab[(y1 * lw + x0) * 4 + j] * (1 - tx) + lab[(y1 * lw + x1) * 4 + j] * tx;
        out4[j] = a * (1 - ty) + b * ty;
      }
    };

    const px = [0, 0, 0, 0];
    for (let y = by0; y <= by1; y++) {
      for (let x = bx0; x <= bx1; x++) {
        const k = (y - by0) * bw + (x - bx0);
        const i = (y * w + x) * ch;
        /* The shape, plus its tinted anti-aliased edge (never the cloth past it). */
        if (!filled[k] && !isFringe(data, i, key)) continue;
        const dx = x - bx0 - cx;
        const dy = y - by0 - cy;
        sample(dx * c + dy * sn - amin, -dx * sn + dy * c - bmin, px);
        let shade = 1;
        if (isCore(data, i, key)) {
          const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          shade = 1 + 0.7 * (Math.min(1.2, Math.max(0.6, lum / refLum)) - 1);
        }
        const alpha = px[3] / 255;
        for (let j = 0; j < 3; j++) {
          const v = (px[j] * alpha + bg[j] * (1 - alpha)) * shade;
          out[i + j] = Math.max(0, Math.min(255, Math.round(v)));
        }
      }
    }
    placed++;
  }

  let keyPixelsLeft = 0;
  for (let p = 0; p < n; p++) if (isCore(out, p * ch, key)) keyPixelsLeft++;

  if (!placed) return { b64: args.imageB64, placed: 0, keyPixelsLeft };
  const img = sharp(out, { raw: { width: w, height: h, channels: ch as 3 } });
  const encoded =
    meta.format === "jpeg"
      ? await img.jpeg({ quality: 95 }).toBuffer()
      : meta.format === "webp"
        ? await img.webp({ quality: 95 }).toBuffer()
        : await img.png().toBuffer();
  return { b64: encoded.toString("base64"), placed, keyPixelsLeft };
}
