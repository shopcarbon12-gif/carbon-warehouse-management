/**
 * CarbonWMS Email — placeholder boxes → real pictures (no network, no database):
 *   npx tsx scripts/test-email-slots.ts [outDir]
 * A fake "AI drawing" with JPEG noise and soft edges: the boxes must be found
 * where they are, and the originals / logo pasted into them.
 */
import assert from "node:assert/strict";
import sharp from "sharp";
import { SLOT_COLORS, TOKEN, briefWithBoxes, findBoxes, pasteReal, slotKeysIn, type Slot } from "../lib/server/email/slots";

const out = process.argv[2];
const solid = (w: number, h: number, c: { r: number; g: number; b: number }) => sharp({ create: { width: w, height: h, channels: 3, background: c } }).png().toBuffer();

(async () => {
  // Tokens → keys (logo first) and the brief the picture model reads.
  const brief = "Top: [[LOGO]] 180 wide. Tile [[PHOTO:p123:4x5]] and [[PHOTO:s1]]; again [[PHOTO:p123]].";
  assert.deepEqual(slotKeysIn(brief), ["logo", "p123", "s1"]);
  const slots: Slot[] = [
    { key: "logo", kind: "logo", label: "the CARBON logo", color: SLOT_COLORS[0] },
    { key: "p123", kind: "product", label: "the photo of Cole Set", color: SLOT_COLORS[1] },
    { key: "s1", kind: "store", label: "the store photo (outside)", color: SLOT_COLORS[2] },
  ];
  const b = briefWithBoxes(brief, slots);
  assert.ok(!TOKEN.test(b) && b.includes("#FF00FF") && b.includes("#00FFFF") && b.includes("#00FF00"));

  // A 1200 x 1600 cream "email" with a dark band (logo box on it), a product box, a store box,
  // and a noisy "photo" that happens to contain magenta-ish pixels (must not count as a box).
  const W = 1200;
  const H = 1600;
  const noise = Buffer.alloc(300 * 300 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 7919) % 256;
  const page = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 240, g: 232, b: 218 } } })
    .composite([
      { input: await solid(W, 220, { r: 15, g: 15, b: 15 }), left: 0, top: 0 },
      { input: await solid(360, 106, { r: 255, g: 0, b: 255 }), left: 420, top: 57 },
      { input: await solid(320, 400, { r: 0, g: 255, b: 255 }), left: 100, top: 400 },
      { input: await solid(600, 400, { r: 0, g: 255, b: 0 }), left: 500, top: 900 },
      { input: await sharp(noise, { raw: { width: 300, height: 300, channels: 3 } }).png().toBuffer(), left: 800, top: 300 },
      // a FRAME instead of a solid box (lime-ish frame 8 px thick around a grey "drawing"), store photo 2
      { input: await solid(300, 200, { r: 128, g: 0, b: 255 }), left: 60, top: 1250 },
      { input: await solid(284, 184, { r: 120, g: 120, b: 120 }), left: 68, top: 1258 },
    ])
    .blur(1.2) // soft edges like a generated picture
    .jpeg({ quality: 72 }) // compression noise
    .toBuffer();
  const png = await sharp(page).png().toBuffer();

  const boxes = await findBoxes(png, SLOT_COLORS.slice(0, 3));
  const near = (a: number, b: number) => Math.abs(a - b) <= 10;
  const one = (hex: string) => {
    const l = boxes.get(hex) ?? [];
    assert.equal(l.length, 1, `${hex}: exactly one box`);
    return l[0];
  };
  const lg = one("#FF00FF");
  const pr = one("#00FFFF");
  const st = one("#00FF00");
  const [fr] = (await findBoxes(png, [SLOT_COLORS[7]])).get("#8000FF") ?? [];
  assert.ok(fr && near(fr.x, 60) && near(fr.y, 1250) && near(fr.w, 300) && near(fr.h, 200), `a frame counts as its whole rectangle ${JSON.stringify(fr)}`);
  assert.ok(near(lg.x, 420) && near(lg.y, 57) && near(lg.w, 360) && near(lg.h, 106), `logo box ${JSON.stringify(lg)}`);
  assert.ok(near(pr.x, 100) && near(pr.y, 400) && near(pr.w, 320) && near(pr.h, 400), `product box ${JSON.stringify(pr)}`);
  assert.ok(near(st.x, 500) && near(st.y, 900) && near(st.w, 600) && near(st.h, 400), `store box ${JSON.stringify(st)}`);
  console.log("ok  boxes found where they are (soft edges, JPEG noise, a noisy photo nearby)");

  // Paste: product = red picture, store = blue picture, logo = a white mark (dark band → white logo).
  const logoWhite = await sharp({ create: { width: 1200, height: 358, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer();
  const logoBlack = await sharp({ create: { width: 1200, height: 358, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } }).png().toBuffer();
  const r = await pasteReal(
    png,
    slots,
    async (s) => (s.key === "p123" ? solid(800, 1000, { r: 200, g: 30, b: 30 }) : solid(1600, 1200, { r: 30, g: 30, b: 200 })),
    { black: async () => logoBlack, white: async () => logoWhite },
  );
  assert.deepEqual(r.found.sort(), ["logo", "p123", "s1"]);
  assert.deepEqual(r.missing, []);
  const px = async (x: number, y: number) => {
    const { data } = await sharp(r.png).extract({ left: x, top: y, width: 1, height: 1 }).raw().toBuffer({ resolveWithObject: true });
    return [data[0], data[1], data[2]];
  };
  const [pr1, pg1] = await px(260, 600);
  assert.ok(pr1 > 150 && pg1 < 80, "product box now shows the product photo");
  const [, , sb] = await px(800, 1100);
  assert.ok(sb > 150, "store box now shows the store photo");
  const [lr] = await px(600, 110);
  assert.ok(lr > 200, "a WHITE logo on the dark band");
  // No leftover box colour at the edges.
  const left = await findBoxes(r.png, SLOT_COLORS.slice(0, 3));
  assert.equal([...left.values()].flat().length, 0, "no box colour left");
  if (out) {
    await sharp(png).resize({ width: 600 }).jpeg().toFile(`${out}/slots-before.jpg`);
    await sharp(r.png).resize({ width: 600 }).jpeg().toFile(`${out}/slots-after.jpg`);
  }
  console.log("ok  originals and the right logo pasted, nothing of the boxes left");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
