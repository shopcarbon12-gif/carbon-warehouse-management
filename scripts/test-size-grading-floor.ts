/**
 * The failure from the warehouse floor, reproduced.
 *
 * A navy tee on wooden floorboards, with a dark pile at one edge, an object in
 * a corner and feet intruding at the bottom — the photo the owner actually
 * took. The border-ring background model has no plain sweep to fit, so it
 * cannot work here; the seeded grow should not care.
 */
import { segmentShirt } from "@/lib/size-grading/measure";
import { segmentGarment } from "@/lib/size-grading/segment";
import { measureGarment } from "@/lib/size-grading/garment";

const W = 540, H = 760, PX_PER_CM = 4;

function scene(): Uint8ClampedArray {
  const b = new Uint8ClampedArray(W * H * 4);
  const put = (x: number, y: number, r: number, g: number, bl: number) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    b[i] = r; b[i + 1] = g; b[i + 2] = bl; b[i + 3] = 255;
  };
  // Wooden floor with plank lines and a bright patch of sunlight.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const plank = (Math.floor(y / 46) % 2) * 8;
      const sun = x > W * 0.5 && y > H * 0.25 ? 46 : 0;
      put(x, y, 150 + plank + sun, 108 + plank + sun, 68 + plank + (sun >> 1));
    }
  }
  // Dark pile down the right edge, and an object in the top-left corner.
  for (let y = H * 0.25; y < H * 0.75; y++) for (let x = W - 60; x < W; x++) put(x, y | 0, 28, 32, 46);
  for (let y = 40; y < 110; y++) for (let x = 60; x < 150; x++) put(x, y, 232, 232, 230);
  // Feet at the bottom.
  for (let y = H - 150; y < H; y++) for (let x = 150; x < 300; x++) put(x, y, 196, 150, 120);

  // The garment: navy tee, body 48 cm (192 px) across, 70 cm (280 px) long.
  const CX = 250, TOP = 250;
  for (let y = TOP; y < TOP + 280; y++) for (let x = CX - 96; x <= CX + 96; x++) put(x, y, 38, 44, 76);
  for (let y = TOP; y < TOP + 66; y++) for (let x = CX - 128; x <= CX + 128; x++) put(x, y, 38, 44, 76);
  return b;
}

const buf = scene();
const seed = { x: 250, y: 430 }; // a tap in the middle of the shirt body

console.log("Scene: navy tee on floorboards, clutter at three edges, feet in frame\n");

const old = segmentShirt(buf, W, H);
const oldRes = measureGarment(old, PX_PER_CM);
const oldArea = ((old.area / (W * H)) * 100).toFixed(1);
console.log(`  border-model (old)  mask covers ${oldArea}% of the frame`);
console.log(
  oldRes.ok
    ? `                      chest ${oldRes.points.chest?.cm.toFixed(1) ?? "—"} cm, length ${oldRes.points.length?.cm.toFixed(1) ?? "—"} cm`
    : `                      ${oldRes.error}`,
);

const seeded = segmentGarment(buf, W, H, seed);
const res = measureGarment(seeded, PX_PER_CM);
const area = ((seeded.area / (W * H)) * 100).toFixed(1);
console.log(`\n  colour model (new)  mask covers ${area}% of the frame`);
if (!res.ok) { console.log(`                      FAIL ${res.error}`); process.exit(1); }
const chest = res.points.chest?.cm ?? 0;
const length = res.points.length?.cm ?? 0;
console.log(`                      type ${res.type}, chest ${chest.toFixed(1)} cm, length ${length.toFixed(1)} cm`);

const ok = res.type === "top" && Math.abs(chest - 48) <= 3 && Math.abs(length - 70) <= 3;
console.log(`\n  ${ok ? "PASS" : "FAIL"} — expected a top, chest 48 cm, length 70 cm (±3)`);
process.exit(ok ? 0 : 1);
