/**
 * Size Grading — garment recognition and measurement, on synthetic silhouettes.
 *
 * Draws each garment family as a flat shape of KNOWN size into a pixel buffer,
 * runs the real segmentation and measurement, and checks both the type it
 * guessed and the centimetres it read back. A photo would test the camera and
 * the lighting; this tests the part that has to be right regardless of either.
 *
 *   npx tsx scripts/test-size-grading.ts
 */
import { segmentShirt } from "@/lib/size-grading/measure";
import { POMS_FOR, measureGarment, type GarmentType, type PomKey } from "@/lib/size-grading/garment";

const W = 600;
const H = 760;
const PX_PER_CM = 4; // 1 cm = 4 px, so a 40 cm waist is 160 px

/** Plain light table with a gentle gradient, the way a real photo looks. */
function canvas(): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const v = 214 + Math.round((x / W) * 10) + Math.round((y / H) * 8);
      buf[i] = v; buf[i + 1] = v; buf[i + 2] = v - 2; buf[i + 3] = 255;
    }
  }
  return buf;
}

function fill(buf: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number) {
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      const i = (y * W + x) * 4;
      buf[i] = 34; buf[i + 1] = 42; buf[i + 2] = 72; buf[i + 3] = 255;
    }
  }
}

/** Trapezoid, for flared skirts and dresses. */
function flare(buf: Uint8ClampedArray, cx: number, yTop: number, yBot: number, wTop: number, wBot: number) {
  for (let y = yTop; y <= yBot; y++) {
    const t = (y - yTop) / Math.max(1, yBot - yTop);
    const w = wTop + (wBot - wTop) * t;
    fill(buf, Math.round(cx - w / 2), y, Math.round(cx + w / 2), y);
  }
}

type Case = {
  name: string;
  expect: GarmentType;
  draw: (b: Uint8ClampedArray) => void;
  /** POM → expected cm, checked to ±tolerance cm. */
  want: Partial<Record<PomKey, number>>;
  tol?: number;
};

const CX = 300;

const CASES: Case[] = [
  {
    // Body 48 cm across (192 px), sleeves out to 64 cm (256 px), 70 cm long.
    name: "T-shirt",
    expect: "top",
    draw: (b) => {
      fill(b, CX - 96, 120, CX + 96, 400);        // body, 192 px wide, 280 px tall
      fill(b, CX - 128, 120, CX + 128, 185);      // sleeves, 256 px wide
    },
    want: { chest: 48, length: 70, hem: 48, shoulder: 64 },
    tol: 2.5,
  },
  {
    // Waist 40 cm (160 px), 100 cm long (400 px), crotch 25 cm down (100 px).
    name: "Trousers",
    expect: "trousers",
    draw: (b) => {
      fill(b, CX - 80, 120, CX + 80, 220);        // seat
      fill(b, CX - 80, 220, CX - 12, 520);        // left leg
      fill(b, CX + 12, 220, CX + 80, 520);        // right leg
    },
    want: { waist: 40, inseam: 75, outseam: 100, legOpening: 17 },
    tol: 3,
  },
  {
    // 40 cm waist, 45 cm long, short legs — as wide as it is tall.
    name: "Shorts",
    expect: "shorts",
    draw: (b) => {
      fill(b, CX - 80, 150, CX + 80, 250);        // seat
      fill(b, CX - 80, 250, CX - 12, 330);        // left leg
      fill(b, CX + 12, 250, CX + 80, 330);        // right leg
    },
    want: { waist: 40, inseam: 20, legOpening: 17 },
    tol: 3,
  },
  {
    // Narrow at the waistband, flaring to the hem — no sleeves, no legs.
    name: "Skirt",
    expect: "skirt",
    draw: (b) => flare(b, CX, 150, 390, 120, 240),
    want: { waist: 30, hem: 60, length: 60 },
    tol: 3,
  },
  {
    // Sleeves at the top AND a leg split at the bottom: a romper. Before this
    // family existed the leg split won and it was measured as a pair of
    // shorts, which reported a waist and threw the whole torso away.
    name: "Romper",
    expect: "onepiece",
    draw: (b) => {
      fill(b, CX - 112, 110, CX + 112, 170);       // sleeves, 224 px = 56 cm
      fill(b, CX - 76, 110, CX + 76, 300);         // torso, 152 px = 38 cm
      fill(b, CX - 88, 300, CX + 88, 360);         // hip, 176 px = 44 cm
      fill(b, CX - 88, 360, CX - 10, 470);         // left leg
      fill(b, CX + 10, 360, CX + 88, 470);         // right leg
    },
    want: { chest: 38, length: 90, inseam: 27.5 },
    tol: 4,
  },
  {
    // Sleeves, and far taller than it is wide.
    name: "Dress",
    expect: "dress",
    draw: (b) => {
      fill(b, CX - 90, 100, CX + 90, 170);        // sleeves
      flare(b, CX, 100, 560, 150, 230);           // body, 115 cm long
    },
    want: { length: 115 },
    tol: 4,
  },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
  const buf = canvas();
  c.draw(buf);
  const mask = segmentShirt(buf, W, H);
  const res = measureGarment(mask, PX_PER_CM);

  if (!res.ok) {
    console.log(`  FAIL  ${c.name.padEnd(10)} — ${res.error}`);
    fail++;
    continue;
  }
  const typeOk = res.type === c.expect;
  const problems: string[] = [];
  if (!typeOk) problems.push(`type ${res.type}, expected ${c.expect}`);

  const tol = c.tol ?? 2;
  const shown: string[] = [];
  for (const [k, expected] of Object.entries(c.want) as Array<[PomKey, number]>) {
    const got = res.points[k]?.cm;
    if (got === undefined) { problems.push(`${k} missing`); continue; }
    shown.push(`${k} ${got.toFixed(1)}`);
    if (Math.abs(got - expected) > tol) problems.push(`${k} ${got.toFixed(1)} ≠ ${expected} ±${tol}`);
  }
  // Every POM the family declares should be produced, or the UI shows a gap.
  const missing = POMS_FOR[res.type].filter((k) => res.points[k] === undefined);

  if (problems.length) {
    console.log(`  FAIL  ${c.name.padEnd(10)} ${problems.join("; ")}`);
    fail++;
  } else {
    console.log(
      `  PASS  ${c.name.padEnd(10)} ${res.type.padEnd(9)} ` +
      `conf ${res.classification.confidence.toFixed(2)}  ${shown.join("  ")}` +
      (missing.length ? `   [not produced: ${missing.join(", ")}]` : ""),
    );
    pass++;
  }
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
