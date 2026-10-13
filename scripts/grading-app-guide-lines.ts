/**
 * Places the measuring lines on CarbonGradingAI's guide pictures.
 *
 * The guide pictures (public/size-grading/guide/app/*.webp) are clean flat
 * lays the owner generated in ChatGPT — no lines, no text, because the app
 * draws its own lettered lines on them. This runs the same close-up AI agent
 * the app's AI assist uses on each profile's main picture and writes the line
 * ends, as fractions of the picture, to lib/size-grading/grading-app-guide-lines.json.
 *
 *   npx tsx scripts/grading-app-guide-lines.ts [--only tee,trousers] [--model gpt-6-astra]
 *
 * Re-run after replacing a picture. The scale is a nominal 11 px/cm (the
 * pictures carry none); only the line positions are kept.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { measureWithAgent } from "@/lib/server/size-grading-agent";
import { GRADING_PROFILES } from "@/lib/size-grading/grading-app-profiles";
import { GUIDE_MAIN } from "@/lib/size-grading/grading-app-guide";

function arg(name: string, def?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

async function main() {
  const only = arg("only")?.split(",");
  const model = arg("model", "gpt-6-astra")!;
  const out = path.join(process.cwd(), "lib/size-grading/grading-app-guide-lines.json");
  const all: Record<string, Record<string, [[number, number], [number, number]]>> = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : {};
  for (const p of GRADING_PROFILES) {
    if (only && !only.includes(p.id)) continue;
    const file = path.join(process.cwd(), "public", GUIDE_MAIN[p.id].replace(/^\//, ""));
    const png = await sharp(file).png().toBuffer();
    const meta = await sharp(png).metadata();
    const W = meta.width!, H = meta.height!;
    const t0 = Date.now();
    const r = await measureWithAgent(
      { image: png, pxPerCm: 11, type: p.family, view: "front", keys: [], points: p.points.map((x) => ({ key: x.key, label: x.label, rule: x.rule })), scale: "depth" },
      { provider: model.startsWith("claude") ? "claude" : "openai", model, maxRounds: 5, effort: "low", deadlineMs: 170_000 },
    );
    const lines: Record<string, [[number, number], [number, number]]> = {};
    for (const [k, l] of Object.entries(r.lines)) {
      if (!l) continue;
      lines[k] = [[+(l.a.x / W).toFixed(4), +(l.a.y / H).toFixed(4)], [+(l.b.x / W).toFixed(4), +(l.b.y / H).toFixed(4)]];
    }
    all[p.id] = lines;
    console.log(`${p.id}: ${Object.keys(lines).length}/${p.points.length} lines, ${((Date.now() - t0) / 1000).toFixed(0)} s, $${r.costUsd.toFixed(3)}${Object.keys(r.skipped).length ? ` skipped ${JSON.stringify(r.skipped)}` : ""}`);
    fs.writeFileSync(out, JSON.stringify(all, null, 1) + "\n");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
