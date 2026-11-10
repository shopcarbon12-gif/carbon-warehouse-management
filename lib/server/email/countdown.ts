/**
 * CarbonWMS Email — a live countdown picture (owner's CARBON pack: "use a live countdown GIF").
 * GET /api/public/email/countdown?to=<ISO>&bg=0A0A0A&fg=F2EFE8&page=E10600 draws DAYS · HRS · MIN · SEC
 * counting down from the moment the email is opened: 60 frames, one per second, as an animated
 * GIF (Gmail, Apple Mail and Outlook.com play it; Outlook for Windows shows the first frame).
 * Drawn with sharp in the pack's Anton / Space Grotesk; cached a few seconds per URL.
 */
import path from "node:path";
import sharp from "sharp";

const W = 540;
const H = 110;
const FONT_DIR = path.join(process.cwd(), "public/email/pack/fonts");
const hex = (s: string | null, fb: string) => (s && /^[0-9a-fA-F]{6}$/.test(s) ? `#${s}` : fb);
const cache = new Map<string, { at: number; gif: Buffer }>();

async function textPng(text: string, font: "Anton" | "Space Grotesk Bold", size: number, color: string): Promise<{ png: Buffer; w: number; h: number }> {
  const file = font === "Anton" ? "anton-400.ttf" : "space-grotesk-700.ttf";
  const img = sharp({ text: { text: `<span foreground="${color}">${text}</span>`, font: `${font} ${size}`, fontfile: path.join(FONT_DIR, file), rgba: true, dpi: 72 } });
  const png = await img.png().toBuffer();
  const m = await sharp(png).metadata();
  return { png, w: m.width ?? 0, h: m.height ?? 0 };
}

const digitCache = new Map<string, { png: Buffer; w: number; h: number }>();
async function piece(text: string, font: "Anton" | "Space Grotesk Bold", size: number, color: string) {
  const k = `${text}|${font}|${size}|${color}`;
  let p = digitCache.get(k);
  if (!p) {
    p = await textPng(text, font, size, color);
    if (digitCache.size > 2000) digitCache.clear();
    digitCache.set(k, p);
  }
  return p;
}

export async function countdownGif(params: URLSearchParams): Promise<Buffer> {
  const to = new Date(params.get("to") ?? "");
  const bg = hex(params.get("bg"), "#0A0A0A");
  const fg = hex(params.get("fg"), "#F2EFE8");
  const page = hex(params.get("page"), bg);
  const key = `${to.getTime()}|${bg}|${fg}|${page}|${Math.floor(Date.now() / 5000)}`;
  const hit = cache.get(key);
  if (hit) return hit.gif;
  const start = Date.now();
  const cellW = 126;
  const gap = (W - cellW * 4) / 3;
  const labels = ["DAYS", "HRS", "MIN", "SEC"];
  const labelPics = await Promise.all(labels.map((l) => piece(l, "Space Grotesk Bold", 13, fg)));
  const frames: Buffer[] = [];
  for (let f = 0; f < 60; f++) {
    const left = Number.isFinite(to.getTime()) ? Math.max(0, Math.floor((to.getTime() - start) / 1000) - f) : 0;
    const parts = [Math.floor(left / 86400), Math.floor((left % 86400) / 3600), Math.floor((left % 3600) / 60), left % 60].map((n) => String(Math.min(99, n)).padStart(2, "0"));
    const cells = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${page}"/>${[0, 1, 2, 3]
      .map((i) => `<rect x="${Math.round(i * (cellW + gap))}" y="0" width="${cellW}" height="${H}" fill="${bg}"/>`)
      .join("")}</svg>`;
    const over: sharp.OverlayOptions[] = [];
    for (let i = 0; i < 4; i++) {
      const x0 = Math.round(i * (cellW + gap));
      const num = await piece(parts[i], "Anton", 46, fg);
      over.push({ input: num.png, left: x0 + Math.round((cellW - num.w) / 2), top: 14 });
      const lab = labelPics[i];
      over.push({ input: lab.png, left: x0 + Math.round((cellW - lab.w) / 2), top: H - lab.h - 12 });
    }
    frames.push(await sharp(Buffer.from(cells)).composite(over).png().toBuffer());
    if (left === 0) break; // over: one still frame
  }
  const gif =
    frames.length > 1
      ? await sharp(frames, { join: { animated: true } }).gif({ delay: frames.map(() => 1000), loop: 0, colours: 16, effort: 4 }).toBuffer()
      : await sharp(frames[0]).gif({ colours: 16 }).toBuffer();
  cache.set(key, { at: Date.now(), gif });
  for (const [k, v] of cache) if (Date.now() - v.at > 30_000) cache.delete(k);
  return gif;
}
