/**
 * The jeans label paste (lib/server/studio-label-composite.ts), on synthetic
 * renders — no image model, no network.
 *
 *   npx tsx scripts/test-studio-label-composite.ts
 *
 * The cases are the ones a real run or the verification pass hit: the
 * renderer's near-square uneven placeholder (the label came out turned 15° and
 * squeezed), a placeholder split by a seam line (two labels), magenta elsewhere
 * in the panel (labels pasted on it), and crops that still hold denim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {
  compositeLabelIntoKey,
  levelMinAreaAngle,
  pickLabelKey,
  readLabelPhoto,
  straightenLabelCrop,
} from "../lib/server/studio-label-composite";

const W = 1536;
const H = 1024;

/** A label whose left half is red and right half green: orientation is measurable. */
async function testLabel() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">
    <rect width="160" height="200" fill="#d01010"/><rect x="160" width="160" height="200" fill="#10b010"/>
    <rect y="0" width="320" height="30" fill="#f0f0f0"/></svg>`;
  return readLabelPhoto(await sharp(Buffer.from(svg)).png().toBuffer());
}

async function panel(shapes: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#5d7fa6"/><rect width="${W}" height="300" fill="#f2f2f2"/>${shapes}</svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString("base64");
}

async function pixels(b64: string) {
  const { data, info } = await sharp(Buffer.from(b64, "base64")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, ch: info.channels };
}

function magentaIn(px: { data: Buffer; w: number; ch: number }, x0: number, y0: number, x1: number, y1: number) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * px.w + x) * px.ch;
      const [r, g, b] = [px.data[i], px.data[i + 1], px.data[i + 2]];
      if (Math.min(r, b) >= 60 && g <= 0.45 * Math.min(r, b)) n++;
    }
  }
  return n;
}

function mean(px: { data: Buffer; w: number; ch: number }, x0: number, y0: number, x1: number, y1: number) {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * px.w + x) * px.ch;
      for (let c = 0; c < 3; c++) s[c] += px.data[i + c];
      n++;
    }
  }
  return s.map((v) => v / n);
}

const KEY = pickLabelKey("light blue jeans, white tee")!;
const LEFT = { x0: 0, x1: 0.5 };

test("pickLabelKey: any pink or purple in the shoot moves the key off magenta", () => {
  assert.equal(pickLabelKey("light blue jeans, white tee")?.name, "magenta");
  assert.equal(pickLabelKey("white tee with neon pink graphic")?.name, "green");
  assert.equal(pickLabelKey("shocking pink logo tee")?.name, "green");
  assert.equal(pickLabelKey("purple shirt, olive cap"), null);
});

test("levelMinAreaAngle: an upright square's ambiguous moments do not tilt it", () => {
  const edge: number[] = [];
  for (let i = -40; i <= 40; i++) edge.push(i, -40, i, 40, -40, i, 40, i);
  assert.equal(levelMinAreaAngle(edge), 0);
});

test("near-square uneven placeholder (the renderer's real shape): one level label, no magenta left", async () => {
  const label = await testLabel();
  const b64 = await panel(`<polygon points="352,312 446,309 449,398 356,404" fill="#f010f0"/>`);
  const r = await compositeLabelIntoKey({ imageB64: b64, label, key: KEY, region: LEFT });
  assert.equal(r.placed, 1);
  assert.equal(r.keyPixelsLeft, 0);
  const px = await pixels(r.b64);
  assert.equal(magentaIn(px, 300, 280, 500, 440), 0);
  /* Red on the left, green on the right, at the label's mid-height: level and not mirrored. */
  const left = mean(px, 365, 360, 385, 372);
  const right = mean(px, 415, 360, 435, 372);
  assert.ok(left[0] > left[1] + 60, `left half should be red: ${left}`);
  assert.ok(right[1] > right[0] + 60, `right half should be green: ${right}`);
});

test("a placeholder split by a thin seam line gets ONE label", async () => {
  const label = await testLabel();
  const b64 = await panel(
    `<rect x="340" y="312" width="120" height="80" fill="#f010f0"/><rect x="340" y="350" width="120" height="2" fill="#30405a"/>`,
  );
  const r = await compositeLabelIntoKey({ imageB64: b64, label, key: KEY, region: LEFT });
  assert.equal(r.placed, 1);
  assert.equal(r.strayShapes, 0);
  assert.equal(r.keyPixelsLeft, 0);
});

test("a second drawn placeholder in the Pose 7 half is painted out, not labelled", async () => {
  const label = await testLabel();
  const b64 = await panel(
    `<rect x="340" y="312" width="120" height="78" fill="#f010f0"/><rect x="560" y="600" width="60" height="40" fill="#f010f0"/>`,
  );
  const r = await compositeLabelIntoKey({ imageB64: b64, label, key: KEY, region: LEFT });
  assert.equal(r.placed, 1);
  assert.equal(r.strayShapes, 1);
  const px = await pixels(r.b64);
  assert.equal(magentaIn(px, 550, 590, 630, 650), 0);
});

test("magenta outside the Pose 7 half is never touched", async () => {
  const label = await testLabel();
  const b64 = await panel(`<rect x="340" y="312" width="120" height="78" fill="#f010f0"/><rect x="1100" y="500" width="120" height="78" fill="#f010f0"/>`);
  const r = await compositeLabelIntoKey({ imageB64: b64, label, key: KEY, region: LEFT });
  assert.equal(r.placed, 1);
  const px = await pixels(r.b64);
  assert.ok(magentaIn(px, 1100, 500, 1220, 578) > 9000, "the right half keeps its own pixels");
});

test("no placeholder: nothing placed, image returned as it was", async () => {
  const label = await testLabel();
  const b64 = await panel("");
  const r = await compositeLabelIntoKey({ imageB64: b64, label, key: KEY, region: LEFT });
  assert.equal(r.placed, 0);
  assert.equal(r.keySeen, 0);
  assert.equal(r.b64, b64);
});

test("straightenLabelCrop: a tight crop is left alone; a crop with a slanted denim strip is cut to the patch", async () => {
  const tight = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="400" height="250" fill="#1c1c1c"/><text x="60" y="230" font-size="40" fill="#eee">CARBON JEANS</text></svg>`))
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(straightenLabelCrop(tight.data, tight.info.width, tight.info.height, tight.info.channels), null);
  const wedge = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250"><rect width="400" height="250" fill="#b8c8dc"/><polygon points="6,0 400,0 400,250 26,250" fill="#1c1c1c"/></svg>`))
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const fixed = straightenLabelCrop(wedge.data, wedge.info.width, wedge.info.height, wedge.info.channels);
  assert.ok(fixed, "the denim wedge is found");
  /* The left column of the result is patch, not denim. */
  let blue = 0;
  for (let y = 10; y < fixed.height - 10; y++) {
    const i = (y * fixed.width + 1) * 3;
    if (fixed.data[i + 2] > 150) blue++;
  }
  assert.ok(blue < 5, `denim left in the first column: ${blue}`);
});
