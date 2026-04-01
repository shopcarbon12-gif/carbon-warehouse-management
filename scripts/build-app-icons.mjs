/**
 * Regenerate app/icon.png, app/apple-icon.png, and app/favicon.ico.
 * Reads **app/icon-source.png** (master artwork) if present, else app/icon.png.
 * Trims border + center-crops so the mark fills the square for small tab sizes.
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

/** Fraction of min(w,h) kept from center; smaller = more zoom (logo larger in tab). */
const CENTER_FRACTION = 0.68;
const OUT_APP = 512;

async function main() {
  if (!fs.existsSync(srcPath)) {
    console.error("Missing app/icon-source.png (or app/icon.png)");
    process.exit(1);
  }
  if (srcPath === fallback) {
    console.warn("Using app/icon.png as source; add app/icon-source.png to avoid double-cropping on re-run.");
  }

  let buf = await sharp(srcPath).trim({ threshold: 8 }).png().toBuffer();
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (!w || !h) throw new Error("Could not read image dimensions");

  const side = Math.max(1, Math.round(Math.min(w, h) * CENTER_FRACTION));
  const left = Math.floor((w - side) / 2);
  const top = Math.floor((h - side) / 2);

  const master = await sharp(buf)
    .extract({ left, top, width: side, height: side })
    .resize(OUT_APP, OUT_APP, { fit: "fill", kernel: sharp.kernel.mitchell })
    .png()
    .toBuffer();

  fs.writeFileSync(path.join(root, "app", "icon.png"), master);
  fs.writeFileSync(path.join(root, "app", "apple-icon.png"), master);

  const sizes = [16, 32, 48];
  const tmpPaths = [];
  try {
    for (const s of sizes) {
      const p = path.join(root, "app", `.fav-${s}.png`);
      await sharp(master)
        .resize(s, s, { fit: "fill", kernel: sharp.kernel.cubic })
        .sharpen({ sigma: 0.6, m1: 1.2, m2: 0.35 })
        .png()
        .toFile(p);
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
