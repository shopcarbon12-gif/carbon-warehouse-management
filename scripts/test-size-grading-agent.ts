/**
 * Size Grading — measure a real photo with the AI agent and compare against a tape.
 *
 *   npx tsx scripts/test-size-grading-agent.ts --photo front.jpg --type top --view front \
 *     [--tape tape.json] [--runs 2] [--rounds 5] \
 *     [--models claude:claude-opus-5-5,claude:claude-sonnet-5-5,claude:claude-haiku-5-5,openai:gpt-5.5] \
 *     [--out /tmp/sg]
 *
 * tape.json: {"unit":"in"|"cm", "chest": 21.5, "length": 28, ...} — keys are the
 * PomKeys in lib/size-grading/garment.ts. Needs ANTHROPIC_API_KEY / OPENAI_API_KEY.
 *
 * The photo goes through exactly what the phone does: decode at ≤1800 px, find
 * the printed target, square the photo up at ≤1400 px. Each run's lines are
 * drawn onto a copy of the picture in --out so a wrong line can be SEEN, and the
 * table prints each point's error against the tape, the run-to-run spread, and
 * what each run cost. Accuracy claims come from this, not from hoping.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { detectTarget, rectify } from "@/lib/size-grading/target";
import { pomsFor, POM_LABEL, type GarmentType, type PomKey } from "@/lib/size-grading/garment";
import { measureWithAgent, type AgentResult, type Provider } from "@/lib/server/size-grading-agent";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

/* Phone photos are stored sideways with an EXIF turn; metadata() reports the
   stored size, so read the upright size or the resize squashes the picture
   (it did, 2026-10-12: a portrait tee measured as a 1400×1050 landscape). */
async function upright(file: string) {
  const meta = await sharp(file).metadata();
  const turned = (meta.orientation ?? 1) >= 5;
  return { img: sharp(file).rotate(), meta: { width: turned ? meta.height : meta.width, height: turned ? meta.width : meta.height } };
}

async function squaredUp(file: string, hires = false) {
  const { img, meta } = await upright(file);
  const scale = Math.min(1, (hires ? 4000 : 1800) / Math.max(meta.width ?? 1, meta.height ?? 1));
  const { data, info } = await img
    .resize(Math.round((meta.width ?? 1) * scale), Math.round((meta.height ?? 1) * scale))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.length);
  const det = detectTarget(rgba, info.width, info.height);
  if (!det) throw new Error(`${file}: no printed target found`);
  const rect = rectify(rgba, info.width, info.height, det.quad, { maxPx: hires ? 3200 : 1400, upright: true });
  if (!rect) throw new Error(`${file}: could not square the photo up`);
  const jpg = await sharp(Buffer.from(rect.data), { raw: { width: rect.width, height: rect.height, channels: 4 } })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { jpg, width: rect.width, height: rect.height, pxPerCm: rect.pxPerCm, confidence: det.confidence };
}

async function rawPicture(file: string, pxPerCm: number) {
  const { img, meta } = await upright(file);
  const scale = Math.min(1, 1400 / Math.max(meta.width ?? 1, meta.height ?? 1));
  const width = Math.round((meta.width ?? 1) * scale), height = Math.round((meta.height ?? 1) * scale);
  const jpg = await img.resize(width, height).jpeg({ quality: 92 }).toBuffer();
  return { jpg, width, height, pxPerCm, confidence: 0 };
}

const COLORS = ["#e6194b", "#f58231", "#d4a000", "#3cb44b", "#0aa5a5", "#4363d8", "#911eb4", "#f032e6", "#808000", "#9a6324", "#008080", "#e6005c", "#5a5aff", "#2f8f2f", "#c71585", "#ff6f00"];

async function drawRun(jpg: Buffer, w: number, h: number, r: AgentResult, keys: PomKey[], file: string) {
  let svg = "";
  keys.forEach((k, i) => {
    const l = r.lines[k];
    if (!l) return;
    const c = COLORS[i % COLORS.length];
    svg += `<line x1="${l.a.x}" y1="${l.a.y}" x2="${l.b.x}" y2="${l.b.y}" stroke="${c}" stroke-width="3"/>`;
    svg += `<circle cx="${l.a.x}" cy="${l.a.y}" r="4" fill="${c}"/><circle cx="${l.b.x}" cy="${l.b.y}" r="4" fill="${c}"/>`;
  });
  const over = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${svg}</svg>`);
  await sharp(jpg).composite([{ input: over, top: 0, left: 0 }]).jpeg({ quality: 88 }).toFile(file);
}

async function main() {
  const photo = arg("photo");
  if (!photo) throw new Error("--photo is required");
  const type = (arg("type") || null) as GarmentType | null;
  const view = (arg("view", "front") as "front" | "back");
  const runs = Number(arg("runs", "1"));
  const rounds = Number(arg("rounds", "5"));
  const out = arg("out", "/tmp/size-grading-agent")!;
  fs.mkdirSync(out, { recursive: true });
  const models = (arg("models", "claude:claude-opus-5-5") as string).split(",").map((s) => {
    const [p, ...m] = s.split(":");
    return { provider: p as Provider, model: m.join(":") };
  });
  const tapeRaw = arg("tape") ? (JSON.parse(fs.readFileSync(arg("tape")!, "utf8")) as Record<string, number | string>) : {};
  const toCm = tapeRaw.unit === "in" ? 2.54 : 1;
  const tape: Partial<Record<PomKey, number>> = {};
  for (const [k, v] of Object.entries(tapeRaw)) if (k !== "unit" && typeof v === "number") tape[k as PomKey] = v * toCm;

  /* --raw: a photo with no printed target. Nothing can be in cm, so the run
     uses a nominal scale and --fit then finds the ONE scale that best matches
     the tape: what is left is placement error (plus the photo's perspective). */
  const pic = process.argv.includes("--raw") ? await rawPicture(photo, Number(arg("pxpercm", "15"))) : await squaredUp(photo, process.argv.includes("--hires"));
  fs.writeFileSync(path.join(out, "squared.jpg"), pic.jpg);
  console.log(`squared up: ${pic.width}×${pic.height}, 1 cm = ${pic.pxPerCm.toFixed(3)} px (target confidence ${pic.confidence.toFixed(2)})`);
  const keys = arg("keys") ? (arg("keys")!.split(",") as PomKey[]) : type ? pomsFor(type, view) : [];

  const all: Record<string, AgentResult[]> = {};
  for (const m of models) {
    const tag = `${m.provider}:${m.model}`;
    all[tag] = [];
    for (let i = 0; i < runs; i++) {
      try {
        const r = await measureWithAgent(
          { image: pic.jpg, pxPerCm: pic.pxPerCm, type, view, keys },
          { provider: m.provider, model: m.model, maxRounds: rounds, log: (s) => console.log(`  [${tag} #${i + 1}] ${s}`) },
        );
        all[tag].push(r);
        const drawKeys = keys.length ? keys : (Object.keys(r.lines) as PomKey[]);
        await drawRun(pic.jpg, pic.width, pic.height, r, drawKeys, path.join(out, `${m.model}-run${i + 1}.jpg`));
        console.log(`  [${tag} #${i + 1}] ${r.garment} — ${(r.ms / 1000).toFixed(0)} s, ${r.zooms} close-ups, $${r.costUsd.toFixed(4)}; ${r.remarks}`);
      } catch (e) {
        console.log(`  [${tag} #${i + 1}] FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (process.argv.includes("--fit")) {
    for (const [t, rs] of Object.entries(all)) {
      for (const r of rs) {
        const ks = (Object.keys(tape) as PomKey[]).filter((k) => r.cm[k] !== undefined);
        const num = ks.reduce((a, k) => a + r.cm[k]! * tape[k]!, 0), den = ks.reduce((a, k) => a + r.cm[k]! ** 2, 0);
        const f = den ? num / den : 1;
        for (const k of Object.keys(r.cm) as PomKey[]) r.cm[k] = Math.round(r.cm[k]! * f * 10) / 10;
        console.log(`  [${t}] fitted scale: 1 cm = ${(pic.pxPerCm / f).toFixed(2)} px`);
      }
    }
  }
  const rowKeys = (keys.length ? keys : [...new Set(Object.values(all).flat().flatMap((r) => Object.keys(r.lines)))]) as PomKey[];
  const unit = tapeRaw.unit === "in" ? "in" : "cm";
  const show = (cm: number | undefined) => (cm === undefined ? "—" : (cm / toCm).toFixed(unit === "in" ? 2 : 1));
  console.log(`\n${"point".padEnd(28)}${"tape".padStart(8)}  ` + Object.keys(all).map((t) => t.split(":")[1].padStart(26)).join(""));
  const errs: Record<string, number[]> = {};
  for (const k of rowKeys) {
    let line = `${POM_LABEL[k].slice(0, 27).padEnd(28)}${show(tape[k]).padStart(8)}  `;
    for (const [t, rs] of Object.entries(all)) {
      const vals = rs.map((r) => r.cm[k]).filter((v): v is number => typeof v === "number");
      const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : undefined;
      const spread = vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : 0;
      const err = mean !== undefined && tape[k] !== undefined ? mean - tape[k]! : undefined;
      if (err !== undefined) (errs[t] ||= []).push(Math.abs(err));
      line += `${show(mean)}${err !== undefined ? ` (${err >= 0 ? "+" : ""}${(err / toCm).toFixed(unit === "in" ? 2 : 1)})` : ""}${vals.length > 1 ? ` ±${(spread / 2 / toCm).toFixed(1)}` : ""}`.padStart(26);
    }
    console.log(line);
  }
  console.log("");
  for (const [t, rs] of Object.entries(all)) {
    const e = errs[t] ?? [];
    const cost = rs.reduce((a, r) => a + r.costUsd, 0) / Math.max(1, rs.length);
    const secs = rs.reduce((a, r) => a + r.ms, 0) / Math.max(1, rs.length) / 1000;
    console.log(
      `${t.padEnd(32)} mean |error| ${e.length ? (e.reduce((a, b) => a + b, 0) / e.length / toCm).toFixed(2) : "—"} ${unit}` +
        `, worst ${e.length ? (Math.max(...e) / toCm).toFixed(2) : "—"} ${unit}, within 1 cm ${e.filter((x) => x <= 1).length}/${e.length}` +
        `, $${cost.toFixed(4)}/photo, ${secs.toFixed(0)} s`,
    );
  }
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(all, null, 1));
  console.log(`\npictures + results.json in ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
