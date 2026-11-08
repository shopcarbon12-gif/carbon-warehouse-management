/**
 * CarbonWMS Email — real pictures pasted into the AI's drawing (owner,
 * 2026-11-08: wrong people in product photos, a logo and store photos that
 * change from picture to picture).
 *
 * The picture model never draws the logo, a store photo, a product photo or an
 * attached photo. The planner marks each spot in its brief with a token —
 *   [[LOGO]] · [[PHOTO:P12]] (product) · [[PHOTO:X3]] (matching set) ·
 *   [[PHOTO:S1]] (store) · [[PHOTO:M7]] (CARBON picture) · [[PHOTO:A1]] (attached) ·
 *   [[PHOTO:H1]] / [[PHOTO:L1]] … (the campaign photos made for this email: hero, looks)
 * — stored with stable keys (logo, p<gid>, s1, m<gid>, a1).
 *
 * Every spot is drawn as the SAME flat magenta box with a short LABEL written
 * large inside it (LOGO, H1, L1–L3, P1…, S1/S2, M1…, A1…). (2026-11-08: one
 * colour per spot failed — the picture model swaps twelve colours and paints
 * shades that match none.) CarbonWMS finds every magenta box, a vision model
 * reads each label, and the ORIGINAL file goes into the box with that label —
 * cropped to the box, the only change ever made to a real photo. A box whose
 * label cannot be read takes the remaining spot whose shape fits best. The
 * logo goes in black or white depending on the background around its box.
 */
import sharp from "sharp";

export const SLOT_COLORS = [
  { hex: "#FF00FF", name: "magenta", rgb: [255, 0, 255] },
  { hex: "#00FFFF", name: "cyan", rgb: [0, 255, 255] },
  { hex: "#00FF00", name: "lime green", rgb: [0, 255, 0] },
  { hex: "#FFFF00", name: "yellow", rgb: [255, 255, 0] },
  { hex: "#0000FF", name: "pure blue", rgb: [0, 0, 255] },
  { hex: "#FF0000", name: "pure red", rgb: [255, 0, 0] },
  { hex: "#FF8000", name: "orange", rgb: [255, 128, 0] },
  { hex: "#8000FF", name: "violet", rgb: [128, 0, 255] },
  { hex: "#00FF80", name: "spring green", rgb: [0, 255, 128] },
  { hex: "#0080FF", name: "azure", rgb: [0, 128, 255] },
  { hex: "#FF0080", name: "hot pink", rgb: [255, 0, 128] },
  { hex: "#80FF00", name: "chartreuse", rgb: [128, 255, 0] },
] as const;
export type SlotColor = (typeof SLOT_COLORS)[number];

export type SlotKind = "logo" | "product" | "store" | "brand" | "attachment" | "shot";
/** One real picture to paste: what it is, the label written in its box, and where its original comes from. */
export type Slot = { key: string; kind: SlotKind; label: string; code: string; color: SlotColor; url?: string | null; path?: string | null };

/** The one box colour (pure magenta, rare in photos, easy to find). */
export const BOX = SLOT_COLORS[0];

/** [[LOGO]] or [[PHOTO:<ref or key>]] (an optional ":4x5" style shape note is allowed and ignored here). */
export const TOKEN = /\[\[\s*(LOGO|PHOTO\s*:\s*([A-Za-z0-9]+))(?:\s*:\s*[0-9]+x[0-9]+)?\s*\]\]/gi;

/** Stable keys in order of first use (the logo first when used). */
export function slotKeysIn(...texts: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const t of texts)
    for (const m of (t ?? "").matchAll(TOKEN)) {
      const key = m[1].toUpperCase() === "LOGO" ? "logo" : m[2].toLowerCase();
      if (!out.includes(key)) out.push(key);
    }
  return out.sort((a, b) => (a === "logo" ? -1 : b === "logo" ? 1 : 0));
}

/** The brief as the picture model reads it: every token becomes "a flat box of exactly <colour>". */
export function briefWithBoxes(brief: string, slots: Slot[]): string {
  return brief.replace(TOKEN, (all, what: string, key?: string) => {
    const k = what.toUpperCase() === "LOGO" ? "logo" : (key ?? "").toLowerCase();
    const s = slots.find((x) => x.key === k);
    if (!s) return "";
    return `[a PLACEHOLDER BOX labelled "${s.code}": one perfectly flat solid magenta (#FF00FF) rectangle with "${s.code}" written large in the centre in bold black capitals — the spot for ${s.label}]`;
  });
}

export const BOX_RULES = (slots: Slot[]) =>
  slots.length
    ? `PLACEHOLDER BOXES (the most important rule): the real ${slots.some((s) => s.kind === "logo") ? "logo and the real " : ""}photos are pasted in later, so you must NOT draw them. Every placeholder box in the brief is ONE perfectly flat, solid MAGENTA (#FF00FF) rectangle — all boxes the same magenta — with its label written large in the centre in bold black capitals (${slots.map((s) => `"${s.code}" = ${s.label}`).join("; ")}). Fill each box SOLID magenta from edge to edge: no gradient, no shadow, no border, no rounded corners, never an outline or frame around a picture, never a photo, person or drawing inside it — only its label. Draw each box at the size and shape the brief gives (a product tile is usually portrait 4:5; the hero landscape; a look photo portrait; a logo box wide and short, about 3.4 times wider than tall). Magenta, pink and fuchsia are reserved for the boxes: never use them anywhere else in the picture — not for accents, buttons, lines, text or outlines.`
    : "";

/** A found box with its shape. */
export type FoundBox = { x: number; y: number; w: number; h: number };

/** Shape of a box or spot: logo (very wide), landscape, square, portrait. */
function shapeOf(w: number, h: number): number {
  return w / Math.max(1, h);
}
const expectedShape = (s: Slot) => (s.kind === "logo" ? 3.4 : s.kind === "store" || s.code === "H1" ? 1.5 : s.kind === "product" ? 0.8 : s.kind === "shot" ? 0.67 : 1);

/**
 * Which slot goes in which box: first by the label read inside the box; boxes whose label could not be
 * read take the remaining slots, best shape first (reading order breaks ties). A slot can fill several
 * boxes when the label repeats (the logo at the top and the bottom).
 */
export function assignBoxes(boxes: FoundBox[], labels: (string | null)[], slots: Slot[]): { box: FoundBox; slot: Slot }[] {
  const out: { box: FoundBox; slot: Slot }[] = [];
  const free: FoundBox[] = [];
  boxes.forEach((b, i) => {
    const l = (labels[i] ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const slot = slots.find((s) => s.code === l);
    if (slot) out.push({ box: b, slot });
    else free.push(b);
  });
  const left = slots.filter((s) => !out.some((o) => o.slot.key === s.key));
  for (const b of free) {
    if (!left.length) break;
    const r = shapeOf(b.w, b.h);
    left.sort((a, c) => Math.abs(Math.log(expectedShape(a) / r)) - Math.abs(Math.log(expectedShape(c) / r)));
    // Only a clear fit (shape within ~1.6×, not tiny): a pink-outlined button never becomes a photo spot.
    if (Math.abs(Math.log(expectedShape(left[0]) / r)) > Math.log(1.6) || b.w * b.h < 120 * 90) continue;
    out.push({ box: b, slot: left.shift()! });
  }
  return out;
}

type Box = { x: number; y: number; w: number; h: number };

/** Find the solid boxes of each colour (connected regions that fill most of their bounding box). */
export async function findBoxes(png: Buffer, colors: readonly SlotColor[], pale = false): Promise<Map<string, Box[]>> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const S = 1; // every pixel: frames the model draws can be only 1-3 px wide
  const gw = Math.floor(W / S);
  const gh = Math.floor(H / S);
  const label = new Int8Array(gw * gh).fill(-1);
  // The model's "lime" or "cyan" is rarely the exact value: accept anything close, and take the NEAREST
  // box colour (the colours are at least ~127 apart, so neighbours cannot be confused).
  const TOL = 90 * 90;
  const off = Math.floor(S / 2);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const i = ((gy * S + off) * W + gx * S + off) * 3;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (pale) {
        if (isPale(r, g, b)) label[gy * gw + gx] = 0;
        continue;
      }
      let best = -1;
      let bestD = TOL;
      for (let c = 0; c < colors.length; c++) {
        const [cr, cg, cb] = colors[c].rgb;
        const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      if (best >= 0) label[gy * gw + gx] = best;
    }
  const seen = new Uint8Array(gw * gh);
  const out = new Map<string, Box[]>();
  const stack: number[] = [];
  for (let start = 0; start < label.length; start++) {
    const c = label[start];
    if (c < 0 || seen[start]) continue;
    let minX = gw;
    let minY = gh;
    let maxX = 0;
    let maxY = 0;
    let n = 0;
    const pts: number[] = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % gw;
      const y = (p - x) / gw;
      n++;
      pts.push(p);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - gw, p + gw]) {
        if (q < 0 || q >= label.length || seen[q] || label[q] !== c) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === gw - 1)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    if (bw * S < 36 || bh * S < 24) continue;
    if (pale && (n / (bw * bh) < 0.8 || bw < 60 || bh < 40)) continue;
    // A FRAME (the model sometimes draws a coloured border with something inside instead of a solid
    // box): the colour runs along all four sides. Its whole outer rectangle is the spot.
    if (n / (bw * bh) < 0.72) {
      const band = 3;
      const top = new Set<number>();
      const bottom = new Set<number>();
      const left = new Set<number>();
      const right = new Set<number>();
      for (const p of pts) {
        const x = p % gw;
        const y = (p - x) / gw;
        if (y - minY < band) top.add(x);
        if (maxY - y < band) bottom.add(x);
        if (x - minX < band) left.add(y);
        if (maxX - x < band) right.add(y);
      }
      const frame = top.size >= bw * 0.75 && bottom.size >= bw * 0.75 && left.size >= bh * 0.75 && right.size >= bh * 0.75;
      if (!frame) continue;
      const pad = S + 1;
      const box = { x: Math.max(0, minX * S - pad), y: Math.max(0, minY * S - pad), w: 0, h: 0 };
      box.w = Math.min(W, (maxX + 1) * S + pad) - box.x;
      box.h = Math.min(H, (maxY + 1) * S + pad) - box.y;
      const list = out.get(colors[c].hex) ?? [];
      list.push(box);
      out.set(colors[c].hex, list);
      continue;
    }
    // Exact edges at full size: walk outward from the grid box along three lines across it while
    // the box colour continues (majority of the lines), then add 2 px for soft edges.
    const [cr, cg, cb] = colors[c].rgb;
    const hit = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      const i = (y * W + x) * 3;
      if (pale) return isPale(data[i], data[i + 1], data[i + 2]);
      return (data[i] - cr) ** 2 + (data[i + 1] - cg) ** 2 + (data[i + 2] - cb) ** 2 < TOL;
    };
    const ys = [0.25, 0.5, 0.75].map((f) => Math.round((minY + (maxY - minY) * f) * S + 1));
    const xs = [0.25, 0.5, 0.75].map((f) => Math.round((minX + (maxX - minX) * f) * S + 1));
    const colOn = (x: number) => ys.filter((y) => hit(x, y)).length >= 2;
    const rowOn = (y: number) => xs.filter((x) => hit(x, y)).length >= 2;
    let x0 = minX * S + 1;
    while (x0 > 0 && colOn(x0 - 1)) x0--;
    while (x0 < (maxX + 1) * S && !colOn(x0)) x0++;
    let x1 = maxX * S + 1;
    while (x1 < W - 1 && colOn(x1 + 1)) x1++;
    while (x1 > x0 && !colOn(x1)) x1--;
    let y0 = minY * S + 1;
    while (y0 > 0 && rowOn(y0 - 1)) y0--;
    while (y0 < (maxY + 1) * S && !rowOn(y0)) y0++;
    let y1 = maxY * S + 1;
    while (y1 < H - 1 && rowOn(y1 + 1)) y1++;
    while (y1 > y0 && !rowOn(y1)) y1--;
    const pad = 2;
    const box = { x: Math.max(0, x0 - pad), y: Math.max(0, y0 - pad), w: 0, h: 0 };
    box.w = Math.min(W, x1 + 1 + pad) - box.x;
    box.h = Math.min(H, y1 + 1 + pad) - box.y;
    const list = out.get(colors[c].hex) ?? [];
    list.push(box);
    out.set(colors[c].hex, list);
  }
  return out;
}

/** The average colour just outside a box (the background a logo sits on). */
async function surround(png: Buffer, b: Box, W: number, H: number): Promise<[number, number, number]> {
  const m = 10;
  const areas = [
    { left: b.x, top: Math.max(0, b.y - m), width: b.w, height: Math.min(m, b.y) },
    { left: b.x, top: Math.min(H - 1, b.y + b.h), width: b.w, height: Math.min(m, H - (b.y + b.h)) },
  ].filter((a) => a.width > 0 && a.height > 0);
  let r = 0;
  let g = 0;
  let bl = 0;
  let n = 0;
  for (const a of areas) {
    // stats() reads the input image, not the result of extract(): cut the strip out first.
    const strip = await sharp(png).extract(a).png().toBuffer();
    const st = await sharp(strip).stats();
    r += st.channels[0].mean;
    g += st.channels[1].mean;
    bl += st.channels[2].mean;
    n++;
  }
  return n ? [r / n, g / n, bl / n] : [255, 255, 255];
}

export type Loader = (slot: Slot) => Promise<Buffer | null>;

/** Every magenta box in a picture, in reading order (top to bottom, then left to right). */
export async function findLabelledBoxes(png: Buffer): Promise<FoundBox[]> {
  const list = (await findBoxes(png, [BOX])).get(BOX.hex) ?? [];
  return list.sort((a, b) => (Math.abs(a.y - b.y) < 24 ? a.x - b.x : a.y - b.y));
}

/**
 * Remove an outer FRAME the model sometimes draws around a phone part (a grey page with the email as a
 * smaller card inside, 2026-11-08), so the part is the email edge to edge and both parts join at the
 * same width and text size. A plain page margin (the email's own background) is never cut: the strip
 * only counts when the column just inside it is a different colour over most of its height.
 */
export async function trimFrame(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const px = (x: number, y: number) => {
    const i = (y * W + x) * 3;
    return [data[i], data[i + 1], data[i + 2]];
  };
  const near = (a: number[], c: number[]) => (a[0] - c[0]) ** 2 + (a[1] - c[1]) ** 2 + (a[2] - c[2]) ** 2 < 14 * 14;
  const share = (x: number, c: number[]) => {
    let n = 0;
    for (let y = 0; y < H; y += 2) if (near(px(x, y), c)) n++;
    return n / Math.ceil(H / 2);
  };
  const side = (from: number, step: number): number => {
    const c = px(from, Math.floor(H / 2));
    let k = 0;
    while (k < W * 0.15 && share(from + step * k, c) >= 0.97) k++;
    if (k < W * 0.02 || k >= W * 0.15) return 0;
    return share(from + step * (k + 2), c) <= 0.4 ? k : 0;
  };
  const L = side(0, 1);
  const R = side(W - 1, -1);
  if (!L || !R) return png;
  // The same frame colour above and below the card is cut too.
  const c = px(0, Math.floor(H / 2));
  const rowIs = (y: number) => {
    let n = 0;
    let t = 0;
    for (let x = L; x < W - R; x += 2, t++) if (near(px(x, y), c)) n++;
    return n / t >= 0.97;
  };
  let T = 0;
  while (T < H * 0.2 && rowIs(T)) T++;
  let B = 0;
  while (B < H * 0.2 && rowIs(H - 1 - B)) B++;
  return sharp(png).extract({ left: L, top: T, width: W - L - R, height: H - T - B }).png({ compressionLevel: 9 }).toBuffer();
}

/** A washed-out magenta (pale pink / lilac) the model sometimes paints instead of #FF00FF. */
function isPale(r: number, g: number, b: number): boolean {
  return r >= 195 && b >= 180 && r - g >= 14 && b - g >= 8 && Math.abs(r - b) <= 45;
}

/**
 * Flat PALE-pink boxes (2026-11-08: a footer "LOGO" box and an "L2" box were drawn light pink and never
 * found). Only used for spots still missing, and a box only counts when its label is read as one of them.
 */
export async function findPaleBoxes(png: Buffer): Promise<FoundBox[]> {
  const list = (await findBoxes(png, [BOX], true)).get(BOX.hex) ?? [];
  return list.sort((a, b) => (Math.abs(a.y - b.y) < 24 ? a.x - b.x : a.y - b.y));
}

/** Paste every original into its assigned boxes. */
export async function pasteAssigned(
  png: Buffer,
  assigned: { box: FoundBox; slot: Slot }[],
  load: Loader,
  logos: { black: () => Promise<Buffer>; white: () => Promise<Buffer> },
): Promise<{ png: Buffer; found: string[]; missing: string[] }> {
  const meta = await sharp(png).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const layers: sharp.OverlayOptions[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  for (const { box: b, slot: s } of assigned) {
    if (!found.includes(s.key)) found.push(s.key);
    {
      if (s.kind === "logo") {
        const [r, g, bl] = await surround(png, b, W, H);
        const dark = 0.2126 * r + 0.7152 * g + 0.0722 * bl < 128;
        const logo = await (dark ? logos.white() : logos.black());
        const fitted = await sharp(logo).resize({ width: b.w, height: b.h, fit: "inside" }).png().toBuffer();
        const fm = await sharp(fitted).metadata();
        const bg = await sharp({ create: { width: b.w, height: b.h, channels: 3, background: { r: Math.round(r), g: Math.round(g), b: Math.round(bl) } } })
          .composite([{ input: fitted, left: Math.round((b.w - (fm.width ?? b.w)) / 2), top: Math.round((b.h - (fm.height ?? b.h)) / 2) }])
          .png()
          .toBuffer();
        layers.push({ input: bg, left: b.x, top: b.y });
        continue;
      }
      const src = await load(s).catch(() => null);
      if (!src) {
        missing.push(s.key);
        continue;
      }
      // A photo cut to a box WIDER than itself loses height: keep the top, so heads are never cut off
      // (2026-11-08: "attention" kept the bright sneakers and cut both heads off a hero).
      const sm = await sharp(src).rotate().metadata();
      const sw = (sm.autoOrient?.width ?? sm.width) || 1;
      const sh = (sm.autoOrient?.height ?? sm.height) || 1;
      // (A store photo keeps "attention": its top is sky and roof.)
      const position = s.kind !== "store" && b.w / b.h > sw / sh ? "north" : sharp.strategy.attention;
      const fill = await sharp(src).rotate().flatten({ background: "#ffffff" }).resize({ width: b.w, height: b.h, fit: "cover", position }).png().toBuffer();
      layers.push({ input: fill, left: b.x, top: b.y });
    }
  }
  const pasted = layers.length ? await sharp(png).composite(layers).png({ compressionLevel: 9 }).toBuffer() : png;
  return { png: await cleanMagenta(pasted), found, missing };
}

/**
 * Any magenta left after pasting (a sliver beside a label the model wrote across a box, a box nobody
 * claimed) is painted in the colour around it, so no pink is ever left in a picture.
 */
export async function cleanMagenta(png: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const TOL = 90 * 90;
  const [mr, mg, mb] = BOX.rgb;
  const isMag = (i: number) => (data[i] - mr) ** 2 + (data[i + 1] - mg) ** 2 + (data[i + 2] - mb) ** 2 < TOL;
  const seen = new Uint8Array(W * H);
  let changed = false;
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || !isMag(start * 3)) continue;
    const pts: number[] = [];
    const stack = [start];
    seen[start] = 1;
    let minX = W, minY = H, maxX = 0, maxY = 0;
    while (stack.length) {
      const p = stack.pop()!;
      pts.push(p);
      const x = p % W;
      const y = (p - x) / W;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - W, p + W]) {
        if (q < 0 || q >= W * H || seen[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
        if (!isMag(q * 3)) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (pts.length < 6) continue;
    // The average colour of a 4 px ring around it (not magenta).
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = Math.max(0, minY - 4); y <= Math.min(H - 1, maxY + 4); y++)
      for (let x = Math.max(0, minX - 4); x <= Math.min(W - 1, maxX + 4); x++) {
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) continue;
        const i = (y * W + x) * 3;
        if (isMag(i)) continue;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    const fill = n ? [r / n, g / n, b / n] : [255, 255, 255];
    for (const p of pts) {
      data[p * 3] = fill[0];
      data[p * 3 + 1] = fill[1];
      data[p * 3 + 2] = fill[2];
    }
    changed = true;
  }
  if (!changed) return png;
  return sharp(data, { raw: { width: W, height: H, channels: 3 } }).png({ compressionLevel: 9 }).toBuffer();
}

/** The real logo placed at the top centre when the model never drew its box (white or black by background). */
export async function placeLogoOnTop(png: Buffer, logos: { black: () => Promise<Buffer>; white: () => Promise<Buffer> }): Promise<Buffer> {
  const m = await sharp(png).metadata();
  const W = m.width ?? 0;
  const w = Math.round(W * 0.3);
  const h = Math.round(w / 3.35);
  const top = Math.round(W * 0.04);
  const left = Math.round((W - w) / 2);
  const area = await sharp(png).extract({ left, top, width: w, height: h }).png().toBuffer();
  const st = await sharp(area).stats();
  const dark = 0.2126 * st.channels[0].mean + 0.7152 * st.channels[1].mean + 0.0722 * st.channels[2].mean < 128;
  const logo = await sharp(await (dark ? logos.white() : logos.black())).resize({ width: w, height: h, fit: "inside" }).png().toBuffer();
  return sharp(png).composite([{ input: logo, left, top }]).png({ compressionLevel: 9 }).toBuffer();
}
