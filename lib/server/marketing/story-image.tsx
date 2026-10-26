/**
 * Social — one Story picture (1080×1920) made from a feed post's campaign
 * shot: cropped to 9:16 around the tagged product, with the product's name and
 * price and shopcarbon.com on a soft dark fade at the bottom. The text is
 * drawn with next/og (Satori + Resvg, its own font), then laid on the photo
 * with sharp, so the server needs no system fonts.
 */
import sharp from "sharp";
import { ImageResponse } from "next/og";

const W = 1080;
const H = 1920;

export async function renderStoryImage(photo: Buffer, focus: { x: number; y: number } | null, text: { name: string; price: string | null }): Promise<Buffer> {
  const img = sharp(photo).rotate();
  const meta = await img.metadata();
  const w = meta.width ?? W;
  const h = meta.height ?? H;
  // 9:16 window as tall as the photo, centred on the product (or the middle).
  let left = 0, top = 0, cw = w, ch = h;
  if (w / h > W / H) {
    cw = Math.round((h * W) / H);
    left = Math.round(Math.min(Math.max((focus?.x ?? 0.5) * w - cw / 2, 0), w - cw));
  } else {
    ch = Math.round((w * H) / W);
    top = Math.round(Math.min(Math.max((focus?.y ?? 0.5) * h - ch / 2, 0), h - ch));
  }
  const base = await img.extract({ left, top, width: cw, height: ch }).resize(W, H, { fit: "cover" }).toBuffer();

  const overlay = new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            padding: "0 80px 170px 80px",
            height: 640,
            justifyContent: "flex-end",
            backgroundImage: "linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.62))",
            color: "white",
          }}
        >
          <div style={{ fontSize: 62, fontWeight: 600, lineHeight: 1.1, letterSpacing: 1 }}>{text.name}</div>
          <div style={{ fontSize: 40, marginTop: 22, opacity: 0.92, letterSpacing: 2 }}>
            {[text.price, "shopcarbon.com"].filter(Boolean).join("  ·  ")}
          </div>
        </div>
      </div>
    ),
    { width: W, height: H },
  );
  const layer = Buffer.from(await overlay.arrayBuffer());
  return sharp(base).composite([{ input: layer }]).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}
