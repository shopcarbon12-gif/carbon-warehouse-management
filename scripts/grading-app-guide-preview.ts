/**
 * Draws CarbonGradingAI's guide lines on the guide pictures, for checking by
 * eye after scripts/grading-app-guide-lines.ts.
 *   npx tsx scripts/grading-app-guide-preview.ts <out-dir>
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { GRADING_PROFILES } from "@/lib/size-grading/grading-app-profiles";
import { GUIDE_MAIN } from "@/lib/size-grading/grading-app-guide";
import lines from "@/lib/size-grading/grading-app-guide-lines.json";

const COLORS = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#00a6a6", "#f032e6", "#9a6324", "#008080", "#800000", "#000075", "#808000"];

async function main() {
  const out = process.argv[2] ?? "guide-preview";
  fs.mkdirSync(out, { recursive: true });
  for (const p of GRADING_PROFILES) {
    const file = path.join(process.cwd(), "public", GUIDE_MAIN[p.id].replace(/^\//, ""));
    const meta = await sharp(file).metadata();
    const W = meta.width!, H = meta.height!;
    const L = (lines as unknown as Record<string, Record<string, [[number, number], [number, number]]>>)[p.id] ?? {};
    let svg = "";
    p.points.forEach((pt, i) => {
      const l = L[pt.key];
      if (!l) return;
      const c = COLORS[i % COLORS.length];
      const [a, b] = l.map(([x, y]) => [x * W, y * H]);
      svg += `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" stroke="${c}" stroke-width="5"/><circle cx="${a[0]}" cy="${a[1]}" r="7" fill="${c}"/><circle cx="${b[0]}" cy="${b[1]}" r="7" fill="${c}"/>`;
      svg += `<text x="${(a[0] + b[0]) / 2 + 6}" y="${(a[1] + b[1]) / 2 - 6}" font-size="26" font-family="sans-serif" font-weight="bold" fill="${c}" stroke="#fff" stroke-width="1">${pt.letter}${pt.side ?? ""} ${pt.label}</text>`;
    });
    await sharp(file).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svg}</svg>`) }]).jpeg({ quality: 85 }).toFile(path.join(out, `${p.id}.jpg`));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
