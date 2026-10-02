/**
 * Size Grading — does the focus check separate a sharp photo from a blurred
 * one, at the size the workspace actually measures?
 *
 * Draws a synthetic garment-on-a-table with the detail a real photo has (a
 * boundary, a seam, a print, fabric weave, sensor noise), blurs it by a known
 * amount, then puts it through the same resize the real pipeline does — the
 * phone shrinks a sensor still to 2048 px and the workspace shrinks that to
 * 1000 — and reads the score off the result.
 *
 * Two things this is here to stop:
 *
 *   1. A blurred photo measuring silently. That is the bug the operator hit:
 *      the phone sent a soft photo and the app measured it anyway.
 *   2. The warning crying wolf. Resizing removes fine detail from a GOOD photo
 *      too, so thresholds calibrated on a full-resolution synthetic would flag
 *      every real photo, and a warning nobody believes is worse than none.
 *
 * Blur is expressed as a fraction of the frame, not in pixels, because that is
 * what survives a resize: a lens that misses focus softens a photo by a couple
 * of percent of its width whatever the sensor's resolution.
 *
 *   npx tsx scripts/test-sharpness.ts
 */
import {
  MIN_CONTRAST,
  SHARP_SCORE,
  USABLE_SCORE,
  focusReading,
  type FocusVerdict,
} from "@/lib/size-grading/sharpness";

/** Stand-in for a phone still after its first shrink; halved again below. */
const SHOT = 960;

type Buf = { buf: Uint8ClampedArray; w: number; h: number };

function scene(size: number, flat = false): Buf {
  const buf = new Uint8ClampedArray(size * size * 4);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  const k = size / 480;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inGarment = x > 90 * k && x < 390 * k && y > 70 * k && y < 410 * k;
      let v: number;
      if (flat) {
        // White garment on a white table: nothing to focus on either way.
        v = inGarment ? 243 : 247;
      } else if (inGarment) {
        // Fabric weave — the fine detail a lens focuses on, and the first thing
        // to go when it misses.
        v = 58 + ((x + y) % 3) * 7 + (x % 2) * 4;
        if (Math.abs(x - 240 * k) < 2 * k) v = 96; // a seam
        if (x > 170 * k && x < 310 * k && y > 150 * k && y < 260 * k) v = 196; // a print
      } else {
        v = 214 + ((x * 7 + y * 3) % 5); // a table is not perfectly uniform
      }
      const n = flat ? rnd() * 1.2 : rnd() * 3;
      buf[i] = buf[i + 1] = buf[i + 2] = Math.max(0, Math.min(255, v + n));
      buf[i + 3] = 255;
    }
  }
  return { buf, w: size, h: size };
}

/** Separable box blur, twice — a close enough stand-in for a lens off its plane. */
function blur({ buf, w, h }: Buf, radius: number): Buf {
  let cur = buf;
  if (radius < 1) return { buf: cur, w, h };
  for (let p = 0; p < 2; p++) {
    const tmp = new Uint8ClampedArray(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let d = -radius; d <= radius; d++) {
          s += cur[(y * w + Math.min(w - 1, Math.max(0, x + d))) * 4];
          n++;
        }
        const i = (y * w + x) * 4;
        tmp[i] = tmp[i + 1] = tmp[i + 2] = s / n;
        tmp[i + 3] = 255;
      }
    }
    const out = new Uint8ClampedArray(cur.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        let n = 0;
        for (let d = -radius; d <= radius; d++) {
          s += tmp[(Math.min(h - 1, Math.max(0, y + d)) * w + x) * 4];
          n++;
        }
        const i = (y * w + x) * 4;
        out[i] = out[i + 1] = out[i + 2] = s / n;
        out[i + 3] = 255;
      }
    }
    cur = out;
  }
  return { buf: cur, w, h };
}

/** Box-average downscale — what `drawImage` does when a photo is shrunk. */
function downscale({ buf, w, h }: Buf, factor: number): Buf {
  const dw = Math.max(1, Math.floor(w / factor));
  const dh = Math.max(1, Math.floor(h / factor));
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      let s = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          s += buf[(Math.min(h - 1, y * factor + dy) * w + Math.min(w - 1, x * factor + dx)) * 4];
          n++;
        }
      }
      const i = (y * dw + x) * 4;
      out[i] = out[i + 1] = out[i + 2] = s / n;
      out[i + 3] = 255;
    }
  }
  return { buf: out, w: dw, h: dh };
}

let fail = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(34)} ${detail}`);
  if (!ok) fail++;
};

/* Blur as a share of the frame. Anything at or above 0.4% is visibly soft once
   it has been through the resizes; 1.5% is the photo the operator got from the
   phone, where the whole frame is off its plane. */
const CASES: Array<{ label: string; percent: number }> = [
  { label: "in focus", percent: 0 },
  { label: "a hair soft (0.1%)", percent: 0.1 },
  { label: "visibly soft (0.4%)", percent: 0.4 },
  { label: "soft (0.8%)", percent: 0.8 },
  { label: "out of focus (1.5%)", percent: 1.5 },
  { label: "wrong plane (3%)", percent: 3 },
];

const shot = scene(SHOT);
const results: Array<{ label: string; score: number; verdict: FocusVerdict }> = [];

console.log(`\nthresholds: sharp ≥ ${SHARP_SCORE}, usable ≥ ${USABLE_SCORE}, contrast floor ${MIN_CONTRAST}`);
console.log(`measured after the resize the workspace really does (${SHOT} → ${SHOT / 2} px)\n`);

for (const c of CASES) {
  const radius = Math.round((c.percent / 100) * SHOT);
  const measured = downscale(blur(shot, radius), 2);
  const r = focusReading(measured.buf, measured.w, measured.h);
  results.push({ label: c.label, score: r.score, verdict: r.verdict });
  console.log(`  ${c.label.padEnd(22)} score ${r.score.toFixed(1).padStart(6)}   ${r.verdict}`);
}
console.log("");

const at = (label: string) => results.find((r) => r.label.startsWith(label))!;

check("a focused photo passes", at("in focus").verdict === "sharp", `score ${at("in focus").score.toFixed(1)}`);
check(
  "sub-pixel softness is not cried wolf over",
  at("a hair soft").verdict !== "soft",
  `score ${at("a hair soft").score.toFixed(1)} → ${at("a hair soft").verdict}`,
);
check("a visibly soft photo is refused", at("visibly soft").verdict === "soft", `score ${at("visibly soft").score.toFixed(1)}`);
check("a soft photo is refused", at("soft (").verdict === "soft", `score ${at("soft (").score.toFixed(1)}`);
check(
  "the photo from the phone is refused",
  at("out of focus").verdict === "soft",
  `score ${at("out of focus").score.toFixed(1)}`,
);
check("badly out of focus is refused", at("wrong plane").verdict === "soft", `score ${at("wrong plane").score.toFixed(1)}`);
check(
  // Only while there is signal left: once every reading is under 1 the
  // ordering between them is noise, not a measurement of anything.
  "the score falls as blur grows",
  results.every((r, i) => i === 0 || r.score <= results[i - 1].score || r.score < 1),
  results.map((r) => r.score.toFixed(1)).join(" ≥ "),
);
check(
  "good and bad are far apart",
  at("in focus").score > at("out of focus").score * 2.5,
  `${at("in focus").score.toFixed(1)} vs ${at("out of focus").score.toFixed(1)}`,
);

const flat = scene(SHOT, true);
const flatRead = focusReading(downscale(flat, 2).buf, SHOT / 2, SHOT / 2);
check(
  "a featureless photo is not called soft",
  flatRead.verdict === "flat",
  `contrast ${flatRead.contrast.toFixed(1)} → ${flatRead.verdict}`,
);

// Judging one region alone: the garment, not the table around it.
const blurred = downscale(blur(shot, Math.round(0.015 * SHOT)), 2);
const region = focusReading(blurred.buf, blurred.w, blurred.h, { x: 100, y: 80, w: 280, h: 320 });
check("a region can be judged alone", region.verdict === "soft", `score ${region.score.toFixed(1)}`);

console.log(fail ? `\n${fail} check${fail === 1 ? "" : "s"} FAILED` : "\nall checks passed");
process.exit(fail ? 1 : 0);
