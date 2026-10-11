/**
 * Golden cases for lib/seo/claims.ts — what SEO copy may not say.
 *
 *   npx tsx --test scripts/test-seo-claims.ts
 *
 * Includes the cases a reviewer found the earlier regex missing ("100%
 * recycled") and the live copy the owner objected to ("hexagon logo", the
 * CARBON JEANS waistband label).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { findClaims, stripClaimsFromHtml, stripClaimsFromText } from "@/lib/seo/claims";
import { finishSeoTitle, factsFromStudioSpec } from "@/lib/seo/optimizeCore";

const shorts = { productTitle: "Alex Denim Shorts" };
const kinds = (t: string, ctx = shorts) => findClaims(t, ctx).map((f) => f.kind);

test("percentages and recycled fibres are caught", () => {
  assert.deepEqual(kinds("Made with 100% recycled fibers."), ["material", "material"]);
  assert.ok(kinds("98% cotton, 2% elastane.").includes("material"));
});

test("feel, care, fit, measurement and origin claims are caught", () => {
  assert.deepEqual(kinds("Soft and breathable."), ["feel", "feel"]);
  assert.deepEqual(kinds("Machine wash cold."), ["care"]);
  assert.deepEqual(kinds("They run true to size."), ["fit"]);
  assert.deepEqual(kinds("A 9 in inseam."), ["measurement", "measurement"]);
  assert.deepEqual(kinds("Made in Turkey."), ["origin"]);
});

test("a fit word describing the look is allowed", () => {
  assert.deepEqual(kinds("A relaxed-fit look that sits easy on the hips."), []);
});

test("the owner's live complaint: label and hexagon logo", () => {
  const live = "The back waistband is adorned with a 'CARBON JEANS' label and hexagon logo.";
  const k = kinds(live);
  assert.ok(k.includes("label"));
  assert.ok(k.includes("logo-shape"));
  assert.ok(k.includes("cliche"));
});

test("Carbon Jeans as the brand is caught", () => {
  assert.ok(kinds("Shop Carbon Jeans today.").includes("brand"));
});

test("a leather patch is a label AND a material claim", () => {
  const k = kinds("A leather patch at the back.");
  assert.ok(k.includes("label") && k.includes("material"));
  assert.deepEqual(kinds("A brown rectangle sits at the back."), []);
});

test("words from the product name are never claims", () => {
  assert.deepEqual(kinds("Bracelet Z Leather in black.", { productTitle: "Bracelet Z Leather" }), []);
  assert.deepEqual(kinds("The Royal Satin Top Set in gold.", { productTitle: "Royal Satin Top Set" }), []);
});

test("set pieces never claim to include the other piece", () => {
  const set = { productTitle: "River Top Set", isSet: true };
  assert.ok(kinds("This two-piece set includes the matching bottom.", set).includes("set-contents"));
  assert.deepEqual(kinds("Part of the River set — pair it with the River Bottom.", set), []);
  /* Not a set: "includes" is ordinary English. */
  assert.deepEqual(kinds("The print includes a skull."), []);
});

test("clean visual copy passes untouched", () => {
  const ok = "Black denim shorts, ripped and frayed across the front. Five pockets and a button fly. Wear them with a white tee.";
  assert.deepEqual(kinds(ok), []);
});

test("stripping removes only the offending sentences and bullets", () => {
  const html =
    "<p>Black denim shorts, ripped across the front. Soft cotton you can live in.</p>" +
    "<ul><li>Five pockets</li><li>98% cotton</li><li>Button fly</li></ul>" +
    "<p>The waistband label reads CARBON JEANS.</p>";
  const out = stripClaimsFromHtml(html, shorts);
  assert.equal(out, "<p>Black denim shorts, ripped across the front.</p><ul><li>Five pockets</li><li>Button fly</li></ul>");
  assert.equal(stripClaimsFromText("Ripped black denim shorts. Breathable and soft. Shop them at Carbon.", shorts), "Ripped black denim shorts. Shop them at Carbon.");
});

test("SEO title is the name, an optional descriptor and the brand — never doubled", () => {
  assert.equal(finishSeoTitle("", "alex denim shorts", "Alex Denim Shorts"), "Alex Denim Shorts | Carbon");
  assert.equal(finishSeoTitle("Men's Ripped", "alex denim shorts", "Alex Denim Shorts"), "Alex Denim Shorts – Men's Ripped | Carbon");
  /* A descriptor that repeats the name adds nothing. */
  assert.equal(finishSeoTitle("Alex Denim Shorts", "x", "Alex Denim Shorts"), "Alex Denim Shorts | Carbon");
  assert.equal(finishSeoTitle("Denim Shorts", "x", "Alex Denim Shorts"), "Alex Denim Shorts | Carbon");
  /* Claim words in the descriptor are dropped. */
  assert.equal(finishSeoTitle("Soft Stretch", "x", "Ella Legging"), "Ella Legging | Carbon");
  /* Too long for 60 characters → the name and brand alone. */
  assert.equal(
    finishSeoTitle("Women's Floral Off-Shoulder Ruffled", "x", "Sapphire Tropics Midi Dress"),
    "Sapphire Tropics Midi Dress | Carbon",
  );
});

test("Studio spec lines about labels and patches never reach the copywriter", () => {
  const spec = [
    "1. BACK: woven label with 'CARBON JEANS' and logo.",
    "2. BACK WAISTBAND: brown leather patch reading CARBON JEANS.",
    "3. FRONT: ripped and frayed across both thighs.",
    "4. LOGO: the Carbon logo (a cluster of linked hexagon outlines) printed on the chest.",
  ].join("\n");
  const facts = factsFromStudioSpec(spec);
  assert.ok(!/label|patch|hexagon/i.test(facts), facts);
  assert.ok(/ripped and frayed/.test(facts));
  assert.ok(/the Carbon logo printed on the chest/.test(facts), facts);
});
