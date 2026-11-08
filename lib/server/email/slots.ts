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
 * — stored with stable keys (logo, p<gid>, s1, m<gid>, a1). For each picture,
 * every key gets its own flat colour; the model draws a solid box of exactly
 * that colour; CarbonWMS then finds each box and pastes the ORIGINAL file into
 * it (cropped to the box: the only change ever made to a real photo). The
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
/** One real picture to paste: what it is and where its original comes from. */
export type Slot = { key: string; kind: SlotKind; label: string; color: SlotColor; url?: string | null; path?: string | null };

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
    return `[a PLACEHOLDER BOX: one perfectly flat solid rectangle filled with exactly ${s.color.hex} (${s.color.name}) — the spot for ${s.label}]`;
  });
}

export const BOX_RULES = (slots: Slot[]) =>
  slots.length
    ? `PLACEHOLDER BOXES (the most important rule): the real ${slots.some((s) => s.kind === "logo") ? "logo and the real " : ""}photos are pasted in later, so you must NOT draw them. Every placeholder box in the brief is ONE perfectly flat, solid rectangle in exactly its colour (${slots.map((s) => `${s.color.hex} = ${s.label}`).join("; ")}): no gradient, no texture, no shadow, no border, no rounded corners, no text, logo, person or object inside or over it, nothing overlapping it. Fill each box SOLID with its colour from edge to edge — never an outline, frame or border around a picture, never a photo or drawing inside it. Draw each box at the size and shape the brief gives (a product tile is usually portrait 4:5; a logo box is wide and short, about 3.4 times wider than tall). Use these colours ONLY for the boxes — nowhere else in the picture.`
    : "";

type Box = { x: number; y: number; w: number; h: number };

/** Find the solid boxes of each colour (connected regions that fill most of their bounding box). */
export async function findBoxes(png: Buffer, colors: readonly SlotColor[]): Promise<Map<string, Box[]>> {
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

/** Paste every original into its boxes. Returns the new picture and which slots were found. */
export async function pasteReal(
  png: Buffer,
  slots: Slot[],
  load: Loader,
  logos: { black: () => Promise<Buffer>; white: () => Promise<Buffer> },
): Promise<{ png: Buffer; found: string[]; missing: string[] }> {
  if (!slots.length) return { png, found: [], missing: [] };
  const meta = await sharp(png).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  const boxes = await findBoxes(png, slots.map((s) => s.color));
  const layers: sharp.OverlayOptions[] = [];
  const found: string[] = [];
  const missing: string[] = [];
  for (const s of slots) {
    const list = boxes.get(s.color.hex) ?? [];
    if (!list.length) {
      missing.push(s.key);
      continue;
    }
    found.push(s.key);
    for (const b of list) {
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
      const fill = await sharp(src).rotate().flatten({ background: "#ffffff" }).resize({ width: b.w, height: b.h, fit: "cover", position: sharp.strategy.attention }).png().toBuffer();
      layers.push({ input: fill, left: b.x, top: b.y });
    }
  }
  if (!layers.length) return { png, found, missing };
  return { png: await sharp(png).composite(layers).png({ compressionLevel: 9 }).toBuffer(), found, missing };
}
