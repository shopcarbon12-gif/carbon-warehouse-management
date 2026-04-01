/**
 * Regenerate app/icon.png, app/apple-icon.png, and app/favicon.ico.
 * Reads **app/icon-source.png** (master artwork) if present, else app/icon.png.
 * Trims border, scales the **entire** mark to fit inside the square (zoomed out — nothing clipped).
 *
 *   npm run favicon:build
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pngToIco from "png-to-ico";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const preferred = path.join(root, "app", "icon-source.png");
const fallback = path.join(root, "app", "icon.png");
const srcPath = fs.existsSync(preferred) ? preferred : fallback;

const OUT_APP = 512;
/** Max side for artwork before padding to OUT_APP (6% margin on each side). */
const SAFE_PADDING = 0.06;

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

async function main() {
  if (!fs.existsSync(srcPath)) {
    console.error("Missing app/icon-source.png (or app/icon.png)");
    process.exit(1);
  }
  if (srcPath === fallback) {
    console.warn("Using app/icon.png as source; add app/icon-source.png to avoid double-processing on re-run.");
  }

  const trimmed = await sharp(srcPath).trim({ threshold: 8 }).png().toBuffer();

  const maxSide = Math.max(1, Math.floor(OUT_APP * (1 - 2 * SAFE_PADDING)));
  const innerPng = await sharp(trimmed)
    .resize(maxSide, maxSide, {
      fit: "inside",
      background: WHITE,
      kernel: sharp.kernel.mitchell,
    })
    .flatten({ background: WHITE })
    .png()
    .toBuffer();

  const master = await sharp({
    create: {
      width: OUT_APP,
      height: OUT_APP,
      channels: 4,
      background: WHITE,
    },
  })
    .composite([{ input: innerPng, gravity: "center" }])
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(root, "app", "icon.png"), master);
  fs.writeFileSync(path.join(root, "app", "apple-icon.png"), master);

  const sizes = [16, 32, 48];
  const tmpPaths = [];
  try {
    for (const s of sizes) {
      const p = path.join(root, "app", `.fav-${s}.png`);
      await sharp(master).resize(s, s, { fit: "fill", kernel: sharp.kernel.cubic }).png().toFile(p);
      tmpPaths.push(p);
    }
    const ico = await pngToIco(tmpPaths);
    fs.writeFileSync(path.join(root, "app", "favicon.ico"), ico);
    console.log(
      `Wrote app/icon.png + apple-icon.png (${OUT_APP}px) and favicon.ico (${ico.length} bytes, ${sizes.join("/")} px)`,
    );
  } finally {
    for (const p of tmpPaths) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
