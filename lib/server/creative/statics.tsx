/**
 * CarbonWMS Creative — statics (spec §7.5). The image engine renders the scene + dressed model;
 * TEXT IS NEVER AI-RENDERED: words are drawn with next/og (Satori) templates in CARBON fonts and
 * laid on the picture with sharp. One still → every needed size (4:5 feed, 9:16 story / reel cover).
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { ImageResponse } from "next/og";
import type { BrandBrain } from "./config";
import { getFile } from "./storage";

export const STATIC_SIZES: Record<string, [number, number]> = { "4:5": [1080, 1350], "9:16": [1080, 1920], "1:1": [1080, 1080] };

export type StaticText = { headline?: string | null; sub?: string | null; price?: string | null; cta?: string | null; template: "hook_top" | "price_tag" | "minimal" | "split_word" | "none" };

/** Centre crop (or focus crop) of a still to an aspect, at the export size. */
export async function cropTo(still: Buffer, aspect: string, focus: { x: number; y: number } = { x: 0.5, y: 0.45 }): Promise<Buffer> {
  const [W, H] = STATIC_SIZES[aspect] ?? STATIC_SIZES["4:5"];
  const img = sharp(still).rotate();
  const m = await img.metadata();
  const w = m.width ?? W, h = m.height ?? H;
  let cw = w, ch = h, left = 0, top = 0;
  if (w / h > W / H) {
    cw = Math.round((h * W) / H);
    left = Math.round(Math.min(Math.max(focus.x * w - cw / 2, 0), w - cw));
  } else {
    ch = Math.round((w * H) / W);
    top = Math.round(Math.min(Math.max(focus.y * h - ch / 2, 0), h - ch));
  }
  return img.extract({ left, top, width: cw, height: ch }).resize(W, H, { kernel: "lanczos3" }).jpeg({ quality: 93 }).toBuffer();
}

let fontCache: { key: string; data: ArrayBuffer } | null = null;
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
/** The owner's headline font (Brand Brain), else Anton — a bundled condensed bold face (public/email/pack/fonts). */
async function headlineFont(brand: BrandBrain): Promise<ArrayBuffer> {
  const p = brand.fonts.headlineFile;
  if (p) {
    if (fontCache?.key === p) return fontCache.data;
    try {
      const data = ab((await getFile(p)).bytes);
      fontCache = { key: p, data };
      return data;
    } catch {
      /* fall back */
    }
  }
  return ab(await readFile(path.join(process.cwd(), "public/email/pack/fonts/anton-400.ttf")));
}
const bodyFont = async () => ab(await readFile(path.join(process.cwd(), "public/email/pack/fonts/space-grotesk-700.ttf")));

/** The words as a transparent PNG at the export size (Satori). */
async function textLayer(brand: BrandBrain, aspect: string, t: StaticText): Promise<Buffer | null> {
  if (t.template === "none") return null;
  const [W, H] = STATIC_SIZES[aspect] ?? STATIC_SIZES["4:5"];
  const font = await headlineFont(brand);
  const body = await bodyFont();
  const family = "CarbonBody";
  const safeTop = aspect === "9:16" ? Math.round(H * 0.14) : Math.round(H * 0.06);
  const safeBottom = aspect === "9:16" ? Math.round(H * 0.2) : Math.round(H * 0.06);
  const side = Math.round(W * 0.06);
  const big = Math.round(W * (t.template === "split_word" ? 0.17 : 0.105));
  const el = (
    <div style={{ width: W, height: H, display: "flex", flexDirection: "column", justifyContent: t.template === "price_tag" || t.template === "minimal" ? "flex-end" : "space-between", padding: `${safeTop}px ${side}px ${safeBottom}px`, fontFamily: family, color: "#fff" }}>
      {t.headline && t.template !== "minimal" ? (
        <div style={{ display: "flex", flexDirection: "column", fontFamily: "CarbonHead", fontSize: big, fontWeight: 700, lineHeight: 0.95, textTransform: "uppercase", letterSpacing: "-0.01em", textShadow: "0 4px 28px rgba(0,0,0,.55)" }}>
          {(t.template === "split_word" ? t.headline.split(/\s+/) : [t.headline]).map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex" }} />
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: Math.round(W * 0.015) }}>
        {t.sub ? <div style={{ display: "flex", fontSize: Math.round(W * 0.04), fontWeight: 700, textShadow: "0 2px 14px rgba(0,0,0,.6)" }}>{t.sub}</div> : null}
        <div style={{ display: "flex", alignItems: "center", gap: Math.round(W * 0.025) }}>
          {t.price ? <div style={{ display: "flex", background: brand.colors.ink, color: "#fff", fontSize: Math.round(W * 0.058), fontWeight: 700, padding: `${Math.round(W * 0.01)}px ${Math.round(W * 0.025)}px` }}>{t.price}</div> : null}
          {t.cta ? <div style={{ display: "flex", fontSize: Math.round(W * 0.036), fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", textShadow: "0 2px 14px rgba(0,0,0,.6)" }}>{t.cta}</div> : null}
        </div>
        {t.template === "minimal" && t.headline ? <div style={{ display: "flex", fontSize: Math.round(W * 0.05), fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" }}>{t.headline}</div> : null}
      </div>
    </div>
  );
  const res = new ImageResponse(el, {
    width: W,
    height: H,
    fonts: [
      { name: "CarbonHead", data: font, weight: 700, style: "normal" },
      { name: "CarbonBody", data: body, weight: 700, style: "normal" },
    ],
  });
  return Buffer.from(await res.arrayBuffer());
}

/** A soft dark fade where the words sit, so white type reads on any picture. */
async function fadeLayer(aspect: string, where: "top" | "bottom" | "both"): Promise<Buffer> {
  const [W, H] = STATIC_SIZES[aspect] ?? STATIC_SIZES["4:5"];
  const stops = where === "top" ? `<stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset=".38" stop-color="#000" stop-opacity="0"/>` : where === "bottom" ? `<stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/>` : `<stop offset="0" stop-color="#000" stop-opacity=".5"/><stop offset=".3" stop-color="#000" stop-opacity="0"/><stop offset=".65" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".6"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`);
}

export async function composeStatic(brand: BrandBrain, still: Buffer, aspect: string, text: StaticText, logo?: Buffer | null): Promise<Buffer> {
  const base = await cropTo(still, aspect);
  const [W] = STATIC_SIZES[aspect] ?? STATIC_SIZES["4:5"];
  const layers: sharp.OverlayOptions[] = [];
  if (text.template !== "none") layers.push({ input: await fadeLayer(aspect, text.template === "hook_top" || text.template === "split_word" ? "both" : "bottom") });
  const words = await textLayer(brand, aspect, text);
  if (words) layers.push({ input: words });
  if (logo) {
    const l = await sharp(logo).resize(Math.round(W * 0.26)).png().toBuffer();
    layers.push({ input: l, top: Math.round(W * 0.06), left: Math.round(W * 0.06) });
  }
  return sharp(base).composite(layers).jpeg({ quality: 92 }).toBuffer();
}
