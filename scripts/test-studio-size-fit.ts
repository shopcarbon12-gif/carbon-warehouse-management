/**
 * Studio size fit (lib/studio-size-fit.ts) on real products' measurements
 * (scripts/fixtures-size-fit.json, read 2026-10-24) and the owner's models.
 *
 *   npx tsx scripts/test-studio-size-fit.ts
 *
 * What must hold: a model wears their own size (usual size, or their jeans
 * waist for numbered jeans) unless the numbers say it cannot be worn; the Item
 * instruction decides the cut and a size it names is used; a copied size guide
 * never sets a length; the text says how the size sits on this body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { chooseSizeFit, heightToInches, instructionSize, runFitIntent, type ModelBody, type MeasuredSize } from "@/lib/studio-size-fit";

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures-size-fit.json"), "utf8")) as {
  name: string; sizes: MeasuredSize[]; spec: string; fit: string; instruction: string;
}[];
const product = (n: string) => fixtures.find((f) => f.name === n)!;
const body = (b: Omit<ModelBody, "heightIn">): ModelBody => ({ ...b, heightIn: heightToInches(b.height) });
const Gringo = body({ name: "Gringo", gender: "male", height: "6'1\"", chestIn: 40, waistIn: 32, hipsIn: 39, inseamIn: 33, shoulderIn: 18.5, size: "M", jeansWaist: "32" });
const Latina = body({ name: "Latina", gender: "female", height: "5'8\"", chestIn: 33.5, waistIn: 25.5, hipsIn: 36.5, inseamIn: 32, shoulderIn: 15.5, size: "S", jeansWaist: "26" });
const fitFor = (n: string, b: ModelBody, instruction = product(n).instruction) =>
  chooseSizeFit({ sizes: product(n).sizes, body: b, intent: runFitIntent(instruction, product(n).fit, n), instruction, spec: product(n).spec });

test("numbered jeans: the model's jeans waist (32), never the size guide's length", () => {
  const f = fitFor("Kylo Jeans", Gringo)!;
  assert.equal(f.size, "32");
  assert.doesNotMatch(f.text, /cropped|inseam/i); // copied size guide: no length
});

test("super-slim stretch tee: the instruction's 'super slim' keeps the model in his size (M, snug)", () => {
  const f = fitFor("Damian Shirt", Gringo)!;
  assert.equal(f.size, "M");
  assert.match(f.text, /snug/);
  assert.match(f.text, /hem ends at the hip/); // own measurements → length described
});

test("a size named in the item instruction is the size used", () => {
  const f = fitFor("Damian Shirt", Gringo, "super slim fit, wear size L")!;
  assert.equal(f.size, "L");
  assert.equal(f.basis, "instruction");
  assert.equal(instructionSize("check real size measurements", ["S", "M", "L"]), null);
});

test("elastic-waist shorts and leggings stay in the model's size", () => {
  assert.equal(fitFor("Basic OS Shorts Set", Gringo)!.size, "M");
  assert.equal(fitFor("Ella Legging", Latina)!.size, "S");
});

test("no measured sizes → no size text", () => {
  assert.equal(chooseSizeFit({ sizes: [], body: Gringo, intent: "regular" }), null);
});
