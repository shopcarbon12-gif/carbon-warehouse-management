/**
 * CarbonWMS Email — labelled magenta boxes → real pictures (no network, no database):
 *   npx tsx scripts/test-email-slots.ts [outDir]
 * A fake "AI drawing" with JPEG noise and soft edges: every magenta box must be found where it is (solid
 * boxes and frames), each slot assigned by its label (or by shape when the label is unreadable), and the
 * originals / logo pasted in.
 */
import assert from "node:assert/strict";
import sharp from "sharp";
import { BOX, TOKEN, assignBoxes, briefWithBoxes, findLabelledBoxes, findPaleBoxes, pasteAssigned, placeLogoOnTop, slotKeysIn, type Slot } from "../lib/server/email/slots";

const out = process.argv[2];
const solid = (w: number, h: number, c: { r: number; g: number; b: number }) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();
const MAG = { r: 255, g: 0, b: 255 };

(async () => {
  // Tokens → keys (logo first) and the brief the picture model reads: one magenta, a label per spot.
  const brief = "Top: [[LOGO]] 180 wide. Tile [[PHOTO:p123:4x5]] and [[PHOTO:s1]]; hero [[PHOTO:h1]].";
  assert.deepEqual(slotKeysIn(brief), ["logo", "p123", "s1", "h1"]);
  const slots: Slot[] = [
    { key: "logo", kind: "logo", code: "LOGO", label: "the CARBON logo", color: BOX },
    { key: "p123", kind: "product", code: "P1", label: "the photo of Cole Set", color: BOX },
    { key: "s1", kind: "store", code: "S1", label: "the store photo (outside)", color: BOX },
    { key: "h1", kind: "shot", code: "H1", label: "the campaign hero photo", color: BOX },
  ];
  const b = briefWithBoxes(brief, slots);
  assert.ok(!TOKEN.test(b) && (b.match(/#FF00FF/g) ?? []).length === 4 && /labelled "P1"/.test(b) && /labelled "LOGO"/.test(b));

  // A 1200 x 1600 cream "email": logo box on a dark band, a portrait product box (slightly-off magenta),
  // a landscape store box drawn as a FRAME (8 px border around a grey drawing), a wide hero box with a
  // black "label" inside, and a noisy photo that must not count as a box.
  const W = 1200;
  const H = 1600;
  const noise = Buffer.alloc(300 * 300 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 256;
  const page = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 240, g: 232, b: 218 } } })
    .composite([
      { input: await solid(W, 220, { r: 15, g: 15, b: 15 }), left: 0, top: 0 },
      { input: await solid(360, 106, MAG), left: 420, top: 57 },
      { input: await solid(320, 400, { r: 250, g: 20, b: 245 }), left: 100, top: 400 },
      { input: await solid(600, 400, MAG), left: 500, top: 900 },
      { input: await solid(584, 384, { r: 120, g: 120, b: 120 }), left: 508, top: 908 },
      { input: await solid(1000, 230, MAG), left: 100, top: 1340 },
      { input: await solid(120, 60, { r: 0, g: 0, b: 0 }), left: 540, top: 1420 },
      { input: await sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer(), left: 800, top: 300 },
      // a sliver of magenta beside a black "2-PIECE SET" label (too small to be a box)
      { input: await solid(70, 22, { r: 0, g: 0, b: 0 }), left: 600, top: 760 },
      { input: await solid(30, 22, MAG), left: 670, top: 760 },
    ])
    .blur(1.2)
    .jpeg({ quality: 72 })
    .toBuffer();
  const png = await sharp(page).png().toBuffer();

  const boxes = await findLabelledBoxes(png);
  const near = (a: number, c: number) => Math.abs(a - c) <= 10;
  assert.equal(boxes.length, 4, `four boxes: ${JSON.stringify(boxes)}`);
  const [lg, pr, st, he] = boxes; // reading order
  assert.ok(near(lg.x, 420) && near(lg.y, 57) && near(lg.w, 360) && near(lg.h, 106), `logo ${JSON.stringify(lg)}`);
  assert.ok(near(pr.x, 100) && near(pr.y, 400) && near(pr.w, 320) && near(pr.h, 400), `product ${JSON.stringify(pr)}`);
  assert.ok(near(st.x, 500) && near(st.y, 900) && near(st.w, 600) && near(st.h, 400), `store frame ${JSON.stringify(st)}`);
  assert.ok(near(he.x, 100) && near(he.y, 1340) && near(he.w, 1000) && near(he.h, 230), `hero with a label inside ${JSON.stringify(he)}`);
  console.log("ok  magenta boxes found: solid, off-shade, a frame, one with a label inside; a noisy photo ignored");

  // Labels decide; an unreadable label falls back to the best-fitting remaining shape.
  const byLabel = assignBoxes(boxes, ["LOGO", "P1", "S1", "H1"], slots);
  assert.deepEqual(byLabel.map((a) => a.slot.code), ["LOGO", "P1", "S1", "H1"]);
  const mixed = assignBoxes(boxes, ["LOGO", null, null, "h-1"], slots);
  assert.deepEqual(mixed.map((a) => a.slot.code).sort(), ["H1", "LOGO", "P1", "S1"].sort());
  assert.equal(mixed.find((a) => a.box === pr)!.slot.code, "P1", "the tall box → the product");
  assert.equal(mixed.find((a) => a.box === st)!.slot.code, "S1", "the landscape box → the store");
  const swapped = assignBoxes(boxes, ["LOGO", "S1", "P1", "H1"], slots);
  assert.deepEqual(swapped.map((a) => a.slot.code), ["LOGO", "S1", "P1", "H1"], "labels win over shape");
  console.log("ok  each box gets the slot of its label; unreadable labels fall back to shape");

  // Paste: product red, store blue, hero green, logo white on the dark band.
  const logoWhite = await sharp({ create: { width: 1200, height: 358, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  const logoBlack = await sharp({ create: { width: 1200, height: 358, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const colour: Record<string, { r: number; g: number; b: number }> = { p123: { r: 200, g: 30, b: 30 }, s1: { r: 30, g: 30, b: 200 }, h1: { r: 30, g: 160, b: 30 } };
  const r = await pasteAssigned(png, byLabel, async (s) => solid(1600, 1200, colour[s.key]), { black: async () => logoBlack, white: async () => logoWhite });
  assert.deepEqual(r.missing, []);
  const px = async (x: number, y: number) => {
    const { data } = await sharp(r.png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  assert.ok((await px(260, 600))[0] > 150, "product photo in the product box");
  assert.ok((await px(800, 1100))[2] > 150, "store photo in the store box (the frame included)");
  assert.ok((await px(600, 1450))[1] > 120, "hero photo over the label");
  assert.ok((await px(600, 110))[0] > 200, "a WHITE logo on the dark band");
  assert.equal((await findLabelledBoxes(r.png)).length, 0, "no magenta left");
  const [sr, sg, sb] = await px(685, 771);
  assert.ok(!(sr > 200 && sg < 80 && sb > 200), `the magenta sliver is painted over (${sr},${sg},${sb})`);
  // No logo box drawn: the real logo goes on top (black on the light page top here).
  const plain = await solid(1200, 800, { r: 240, g: 232, b: 218 });
  const withLogo = await placeLogoOnTop(plain, { black: async () => logoBlack, white: async () => logoWhite });
  const { data: lp } = await sharp(withLogo).extract({ left: 600, top: 100, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.ok(lp[0] < 60, "a BLACK logo placed at the top centre of a light page");
  // A washed-out pink box is not a magenta box, but is found as a pale one (a pink sweater photo is not).
  const palePage = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 240, g: 232, b: 218 } } })
    .composite([
      { input: await solid(300, 200, { r: 242, g: 214, b: 224 }), left: 60, top: 60 },
      { input: await solid(200, 300, { r: 230, g: 40, b: 140 }), left: 500, top: 200 },
    ])
    .png()
    .toBuffer();
  assert.equal((await findLabelledBoxes(palePage)).length, 0);
  const pales = await findPaleBoxes(palePage);
  assert.equal(pales.length, 1, JSON.stringify(pales));
  assert.ok(near(pales[0].x, 60) && near(pales[0].w, 300), JSON.stringify(pales[0]));
  // A tall photo pasted into a WIDE box keeps its top (heads), never the bottom.
  const tall = await sharp({ create: { width: 400, height: 600, channels: 3, background: { r: 0, g: 0, b: 220 } } })
    .composite([{ input: await solid(400, 150, { r: 220, g: 0, b: 0 }), left: 0, top: 0 }])
    .png()
    .toBuffer();
  const wide = await pasteAssigned(await solid(800, 300, MAG), [{ box: { x: 0, y: 0, w: 800, h: 200 }, slot: slots[3] }], async () => tall, { black: async () => logoBlack, white: async () => logoWhite });
  const { data: tp } = await sharp(wide.png).extract({ left: 400, top: 10, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
  assert.ok(tp[0] > 150 && tp[2] < 80, `the top of the photo is kept (${tp[0]},${tp[1]},${tp[2]})`);
  console.log("ok  pale pink boxes found separately; wide crops keep the top of the photo");
  if (out) {
    await sharp(png).resize({ width: 600 }).jpeg().toFile(`${out}/slots-before.jpg`);
    await sharp(r.png).resize({ width: 600 }).jpeg().toFile(`${out}/slots-after.jpg`);
  }
  console.log("ok  originals and the right logo pasted, nothing magenta left");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
