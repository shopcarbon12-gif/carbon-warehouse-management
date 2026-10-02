/**
 * Size Grading — does the printed target actually make a hand-held photo
 * accurate, and by how much?
 *
 * This is the script behind the accuracy claim. It renders a scene the way a
 * camera would see it — the target and a garment of KNOWN size lying on the
 * same flat surface, viewed through a real perspective transform at a given
 * tilt, distance and rotation, then blurred and noised — finds the target,
 * un-warps the photo, measures the garment on the result, and compares against
 * the size it drew.
 *
 * The number that matters is the error in centimetres at each tilt. If that
 * number is not small, the feature does not work, however good the code looks.
 *
 *   npx tsx scripts/test-target.ts
 */
import { TARGET, applyH, detectTarget, homography, rectify, type Quad } from "@/lib/size-grading/target";
import type { Point } from "@/lib/size-grading/measure";

const IMG_W = 1600;
const IMG_H = 1400;

/** A garment of exactly this size is drawn next to the target. */
const GARMENT = { wCm: 52, hCm: 70 };

type Scene = { buf: Uint8ClampedArray; truthQuad: Quad };

/**
 * Project the flat world onto an image plane with a real camera.
 *
 * Rotating the world about its x-axis by `tiltDeg` and projecting through a
 * pinhole is what a phone held at an angle does; faking it with a sheared
 * homography would test the maths against itself.
 */
function cameraMatrix(tiltDeg: number, rollDeg: number, distanceCm: number) {
  const f = 1200; // focal length in pixels — a typical phone
  const t = (tiltDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  /* Centre on the whole scene, not on the target. Centring on the target put
     the garment off the right-hand edge of the frame, and a garment that is
     clipped measures short no matter how good the rectification is — the first
     run of this test failed every case for exactly that reason. */
  const SCENE_CX = (TARGET.outerWCm + 6 + GARMENT.wCm) / 2;
  const SCENE_CY = (2 + GARMENT.hCm) / 2;
  // World point (X, Y, 0) → camera → image.
  return (X: number, Y: number): Point => {
    const cx = X - SCENE_CX;
    const cy = Y - SCENE_CY;
    // Roll about the view axis.
    const rx = cx * Math.cos(r) - cy * Math.sin(r);
    const ry = cx * Math.sin(r) + cy * Math.cos(r);
    // Tilt about the x-axis.
    const Yc = ry * Math.cos(t);
    const Zc = distanceCm + ry * Math.sin(t);
    return { x: IMG_W / 2 + (f * rx) / Zc, y: IMG_H / 2 + (f * Yc) / Zc };
  };
}

function drawScene(tiltDeg: number, rollDeg: number, distanceCm: number): Scene {
  const buf = new Uint8ClampedArray(IMG_W * IMG_H * 4);
  // A warehouse floor, not a studio sweep: mid-grey with texture.
  let seed = 99;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  for (let i = 0; i < IMG_W * IMG_H; i++) {
    const v = 168 + Math.round(rnd() * 10);
    buf[i * 4] = v;
    buf[i * 4 + 1] = v;
    buf[i * 4 + 2] = v - 3;
    buf[i * 4 + 3] = 255;
  }

  const project = cameraMatrix(tiltDeg, rollDeg, distanceCm);

  /** Fill the image region covered by a world-space rectangle. */
  const fillWorldRect = (x0: number, y0: number, x1: number, y1: number, rgb: [number, number, number]) => {
    // Walk the world rectangle densely enough that no image pixel is missed.
    const stepsX = Math.max(2, Math.ceil((x1 - x0) * 24));
    const stepsY = Math.max(2, Math.ceil((y1 - y0) * 24));
    for (let a = 0; a <= stepsX; a++) {
      for (let b = 0; b <= stepsY; b++) {
        const p = project(x0 + ((x1 - x0) * a) / stepsX, y0 + ((y1 - y0) * b) / stepsY);
        const px = Math.round(p.x);
        const py = Math.round(p.y);
        if (px < 0 || py < 0 || px >= IMG_W || py >= IMG_H) continue;
        const i = (py * IMG_W + px) * 4;
        buf[i] = rgb[0];
        buf[i + 1] = rgb[1];
        buf[i + 2] = rgb[2];
      }
    }
  };

  const W = TARGET.outerWCm;
  const H = TARGET.outerHCm;
  const b = TARGET.borderCm;
  // The ring, drawn as four bars so the middle stays paper-white.
  fillWorldRect(0, 0, W, b, [20, 20, 20]);
  fillWorldRect(0, H - b, W, H, [20, 20, 20]);
  fillWorldRect(0, 0, b, H, [20, 20, 20]);
  fillWorldRect(W - b, 0, W, H, [20, 20, 20]);
  // The paper inside the ring.
  fillWorldRect(b, b, W - b, H - b, [246, 246, 244]);
  // Orientation dot.
  fillWorldRect(b + TARGET.dotInsetCm, b + TARGET.dotInsetCm,
                b + TARGET.dotInsetCm + TARGET.dotCm, b + TARGET.dotInsetCm + TARGET.dotCm, [20, 20, 20]);

  // The garment: a dark rectangle of known size, to the right of the target.
  const gx = W + 6;
  const gy = 2;
  fillWorldRect(gx, gy, gx + GARMENT.wCm, gy + GARMENT.hCm, [44, 52, 86]);

  const truthQuad: Quad = [project(0, 0), project(W, 0), project(W, H), project(0, H)];
  return { buf, truthQuad };
}

/** Separable box blur, to stand in for a lens that is not perfectly sharp. */
function blur(buf: Uint8ClampedArray, w: number, h: number, radius: number): Uint8ClampedArray {
  if (radius < 1) return buf;
  const tmp = new Uint8ClampedArray(buf.length);
  const out = new Uint8ClampedArray(buf.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, n = 0;
      for (let d = -radius; d <= radius; d++) {
        const xx = Math.min(w - 1, Math.max(0, x + d));
        const i = (y * w + xx) * 4;
        r += buf[i]; g += buf[i + 1]; bl += buf[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = bl / n; tmp[o + 3] = 255;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, n = 0;
      for (let d = -radius; d <= radius; d++) {
        const yy = Math.min(h - 1, Math.max(0, y + d));
        const i = (yy * w + x) * 4;
        r += tmp[i]; g += tmp[i + 1]; bl += tmp[i + 2]; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = bl / n; out[o + 3] = 255;
    }
  }
  return out;
}

/** Width and height in cm of the dark garment block in a rectified image. */
function measureGarmentBlock(data: Uint8ClampedArray, w: number, h: number, pxPerCm: number) {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // The garment is the blue-ish dark block; the target ring is neutral dark.
      const r = data[i], b = data[i + 2];
      if (b > r + 18 && b < 150 && r < 110) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { wCm: (maxX - minX + 1) / pxPerCm, hCm: (maxY - minY + 1) / pxPerCm };
}

type Case = { label: string; tilt: number; roll: number; distance: number; blur: number };

const CASES: Case[] = [
  { label: "straight down, 95 cm", tilt: 0, roll: 0, distance: 95, blur: 0 },
  { label: "straight down, 150 cm", tilt: 0, roll: 0, distance: 150, blur: 0 },
  { label: "tilt 10°", tilt: 10, roll: 0, distance: 105, blur: 0 },
  { label: "tilt 20°", tilt: 20, roll: 0, distance: 105, blur: 0 },
  { label: "tilt 30°", tilt: 30, roll: 0, distance: 105, blur: 0 },
  { label: "tilt 15° + roll 25°", tilt: 15, roll: 25, distance: 115, blur: 0 },
  { label: "tilt 15°, slight blur", tilt: 15, roll: 0, distance: 105, blur: 1 },
  { label: "tilt 20°, roll 40°, blur", tilt: 20, roll: 40, distance: 120, blur: 1 },
];

let fail = 0;
const rows: string[] = [];

console.log(`\nGarment drawn at exactly ${GARMENT.wCm} × ${GARMENT.hCm} cm.`);
console.log(`Target ${TARGET.outerWCm} × ${TARGET.outerHCm} cm, ${TARGET.borderCm} cm border.\n`);
console.log("  case                        found  tilt%   width cm   height cm   worst err");

for (const c of CASES) {
  const scene = drawScene(c.tilt, c.roll, c.distance);
  const img = blur(scene.buf, IMG_W, IMG_H, c.blur);

  const det = detectTarget(img, IMG_W, IMG_H);
  if (!det) {
    console.log(`  ${c.label.padEnd(26)} NO`);
    fail++;
    continue;
  }

  // How far the detected corners sit from the truth, in pixels.
  const cornerErr = Math.max(
    ...det.quad.map((p, i) => Math.hypot(p.x - scene.truthQuad[i].x, p.y - scene.truthQuad[i].y)),
  );

  const rect = rectify(img, IMG_W, IMG_H, det.quad, { maxPx: 1200, aroundCm: 75 });
  if (!rect) {
    console.log(`  ${c.label.padEnd(26)} rectify failed`);
    fail++;
    continue;
  }
  const m = measureGarmentBlock(rect.data, rect.width, rect.height, rect.pxPerCm);
  if (!m) {
    console.log(`  ${c.label.padEnd(26)} garment not found after rectify`);
    fail++;
    continue;
  }
  const errW = Math.abs(m.wCm - GARMENT.wCm);
  const errH = Math.abs(m.hCm - GARMENT.hCm);
  const worst = Math.max(errW, errH);
  const ok = worst <= 1.0;
  if (!ok) fail++;
  rows.push(
    `  ${c.label.padEnd(26)} ${ok ? "ok " : "BAD"}   ${det.tiltPercent.toFixed(0).padStart(4)}` +
      `   ${m.wCm.toFixed(1).padStart(7)}   ${m.hCm.toFixed(1).padStart(8)}   ${worst.toFixed(2)} cm` +
      `   (corners ±${cornerErr.toFixed(1)} px)`,
  );
}
console.log(rows.join("\n"));

/* The control: measuring the same scene WITHOUT un-warping, the way a
   two-tap calibration does — a scale taken at the target and applied across
   the photo. This is the error the whole feature exists to remove, so it is
   worth printing rather than asserting. */
{
  const c = { tilt: 20, roll: 0, distance: 105 };
  const scene = drawScene(c.tilt, c.roll, c.distance);
  const det = detectTarget(scene.buf, IMG_W, IMG_H);
  if (det) {
    // Scale from the target's top edge alone, as tapping two corners would give.
    const topPx = Math.hypot(det.quad[1].x - det.quad[0].x, det.quad[1].y - det.quad[0].y);
    const pxPerCm = topPx / TARGET.outerWCm;
    const m = measureGarmentBlock(scene.buf, IMG_W, IMG_H, pxPerCm);
    if (m) {
      console.log(
        `\n  control — same 20° shot, scale-only (what two taps give):` +
          ` ${m.wCm.toFixed(1)} × ${m.hCm.toFixed(1)} cm` +
          `  → off by ${Math.abs(m.hCm - GARMENT.hCm).toFixed(1)} cm on the length`,
      );
    }
  }
}

/* The homography itself must be exact on synthetic input: if this drifts, the
   error above is the maths, not the pixels. */
{
  const src: Quad = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 20 },
    { x: 0, y: 20 },
  ];
  const dst: Quad = [
    { x: 100, y: 120 },
    { x: 400, y: 90 },
    { x: 430, y: 560 },
    { x: 80, y: 520 },
  ];
  const H = homography(src, dst);
  const worst = H
    ? Math.max(...src.map((p, i) => {
        const q = applyH(H, p.x, p.y);
        return Math.hypot(q.x - dst[i].x, q.y - dst[i].y);
      }))
    : Infinity;
  const ok = worst < 1e-6;
  if (!ok) fail++;
  console.log(`\n  ${ok ? "PASS" : "FAIL"}  homography reproduces its own corners (${worst.toExponential(1)} px)`);
}

console.log(fail ? `\n${fail} case${fail === 1 ? "" : "s"} FAILED` : "\nall cases passed");
process.exit(fail ? 1 : 0);
