/**
 * Golden checks for the Studio LOOK SHEET, the choice-free prompt text and the
 * spec risk report. Pure code — no OpenAI call, no database.
 *
 *   npx tsx scripts/test-studio-look-sheet.ts
 *
 * What must hold: one sheet per run (same input → the same bytes, every panel
 * reads it), no "X or Y" left for a panel to settle on its own — in the sheet,
 * in the styling lines the prompt still carries, or in the injected pose text —
 * and the spec guards fire on the real lines the 2026-10-14 audit traced
 * (Camille, the Leopard skort, Jay, Aubri, Wayne).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOOK_SHEET_BUDGET_BYTES,
  instructionHasStyling,
  resolveLookSheet,
  withoutChoiceWords,
  type LookSheetInput,
} from "@/lib/studioLookSheet";
import {
  buildMasterPanelPrompt,
  buildStylingLock,
  getPanelButtonLabel,
  getPanelPosePair,
  itemTypeCategory,
  needsBackWaistbandTuck,
  parseOutfitFromSpec,
  withBackWaistbandVisible,
} from "@/lib/panelGeneration";
import { ACCESSORY_KINDS, accessoryPanelLabel, accessoryShotText, buildAccessoryPanelPrompt, buildAccessoryStylingLock } from "@/lib/accessoryShots";
import { buildPoseVariationDirective } from "@/lib/poseVariation";
import { pose8OptionFor } from "@/lib/panelPoseLibraries";
import { specRiskReport } from "@/lib/studio-item-spec";
import { buildLockText } from "@/lib/server/item-spec-build";

const CHOICE = /\bor\b/i;
const MENU = /pick ONE|choose ONE|Creative Options|Selection Rule|Variation Options|Variation rule|\bOR\b/;

const JAY_SPEC = [
  '4. TEXT (exact spelling, case and letterforms): "CARRON JEANS" at back, waistband patch, bold, white — applied as printed. Reproduce verbatim — never paraphrase, translate, drop, or add letters.',
  "7. ZONE — WAISTBAND: 4 cm high, flat, with belt loops.",
  "16. LABEL/PATCH: leather patch with text 'CARRON JEANS' and logo, back, waistband.",
  "28. OUTFIT — TOP: white T-shirt with black text and graphic print, regular fit, short sleeves.",
  "29. OUTFIT — FOOTWEAR: white sneakers with black stripes on sole, lace-up.",
].join("\n");

const base = (over: Partial<LookSheetInput> = {}): LookSheetInput => ({
  itemType: "JEANS",
  gender: "male",
  specOutfit: parseOutfitFromSpec(JAY_SPEC),
  itemColour: "light blue",
  seedKey: "matrix-1|model-1|light blue",
  keepStylingPrints: false,
  backWaistbandLabel: needsBackWaistbandTuck("JEANS", JAY_SPEC),
  ...over,
});

/* Inputs that cover every category, both genders, swim, every accessory kind,
   and source text that carries an "or" of its own. */
function inputs(): LookSheetInput[] {
  const out: LookSheetInput[] = [];
  const items = ["JEANS", "TOPS", "JACKET", "SET", "DRESS", "BIKINI", "SWIM SHORTS", "SNEAKERS", "BODYSUIT", "SKORT", "SCARF", "OVERALL"];
  for (const gender of ["male", "female"] as const) {
    for (const itemType of items) {
      for (const seedKey of ["a|b|black", "c|d|white", "e|f|red", "g|h|cream"]) {
        out.push(base({ itemType, gender, seedKey, itemColour: seedKey.split("|")[2], specOutfit: {}, backWaistbandLabel: false }));
        out.push(
          base({
            itemType,
            gender,
            seedKey,
            specOutfit: { top: "black sleeveless crop top or tank, no logo or text", bottom: "white or cream wide-leg trousers", footwear: "black or white high-top sneakers" },
            styleWith: { accessories: "a thin gold chain or a silver watch" },
            instructionStyling: { slots: { outerwear: "a black leather jacket or a denim jacket" }, adjust: { top: "oversized" }, tuck: "front-tucked" },
            backWaistbandLabel: true,
          }),
        );
      }
    }
    for (const kind of ACCESSORY_KINDS) {
      for (const seedKey of ["a|b|gold", "c|d|silver", "e|f|black"]) {
        out.push(base({ itemType: kind.toUpperCase(), gender, seedKey, itemColour: seedKey.split("|")[2], accessoryKind: kind, specOutfit: {}, backWaistbandLabel: false }));
        out.push(base({ itemType: kind.toUpperCase(), gender, seedKey, accessoryKind: kind, specOutfit: { top: "black tank or tee", accessories: "a silver watch" }, backWaistbandLabel: false }));
      }
    }
  }
  return out;
}

test("same input → byte-identical sheet; the seed is FNV-1a of the seed key", () => {
  const a = resolveLookSheet(base());
  const b = resolveLookSheet(base());
  assert.equal(a.text, b.text);
  assert.equal(a.seed, b.seed);
  assert.equal(a.version, 1);
  assert.notEqual(resolveLookSheet(base({ seedKey: "matrix-1|model-1|black" })).seed, a.seed);
  for (const input of inputs()) assert.equal(resolveLookSheet(input).text, resolveLookSheet({ ...input }).text);
});

test("no 'or' left in any sheet", () => {
  for (const input of inputs()) {
    const sheet = resolveLookSheet(input);
    assert.ok(!CHOICE.test(sheet.text), `${input.itemType}/${input.gender}/${input.accessoryKind ?? "-"}:\n${sheet.text}`);
    for (const [slot, v] of Object.entries(sheet.slots)) assert.ok(v.trim(), `empty slot ${slot}`);
  }
  assert.equal(withoutChoiceWords("no logo or text"), "no logo, nor text");
  assert.equal(withoutChoiceWords("a crew-neck tee or an open-collar shirt in white"), "an open-collar shirt in white");
  assert.equal(withoutChoiceWords("black or dark navy chinos"), "dark navy chinos");
});

test("the sheet stays inside its byte budget even with 500-character Style-with readings", () => {
  const long = (s: string) => `${s}, ${"a careful description of colour, cut, fit, length, fabric and hardware, ".repeat(8)}`.slice(0, 500);
  for (const accessoryKind of [null, ...ACCESSORY_KINDS]) {
    const sheet = resolveLookSheet(
      base({
        accessoryKind,
        keepStylingPrints: true,
        styleWith: { top: long("black tee"), bottom: long("jeans"), outerwear: long("jacket"), footwear: long("sneakers"), accessories: long("watch") },
        instructionStyling: { adjust: { top: "oversized" }, tuck: "tucked" },
      }),
    );
    assert.ok(Buffer.byteLength(sheet.text, "utf8") <= LOOK_SHEET_BUDGET_BYTES, `${accessoryKind}: ${Buffer.byteLength(sheet.text)} B`);
    assert.ok(!/\s(?:and|with)\s*[;.—]/.test(sheet.text), sheet.text);
  }
});

test("owner styling rules: photographed accessories worn, top always over the pants, label only in Pose 7, no skin", () => {
  const sheet = resolveLookSheet(base());
  assert.match(sheet.text, /^LOOK SHEET/);
  assert.match(sheet.slots.accessories, /^exactly the accessories the item photos show the model wearing/);
  assert.match(sheet.slots.top, /worn untucked over the waistband in every frame/);
  assert.ok(!/tucked in loosely/.test(sheet.text), sheet.slots.top);
  assert.match(sheet.slots.top, /except in Pose 7, the zoomed-in back crop, where only the back hem is lifted to the top edge of the waistband and rests on it/);
  assert.match(sheet.slots.top, /no skin shows between the top and the waistband/);
  // "just clear of it" read as a gap and showed the lower back (Julian Jeans).
  assert.ok(!/clear of it/.test(sheet.text), sheet.slots.top);
  assert.match(sheet.slots.top, /only up to the waistband's top edge, where it rests — never above it/);
  assert.equal((sheet.text.match(/the label below that edge shows in full/g) ?? []).length, 1);
  const her = resolveLookSheet(base({ gender: "female" }));
  assert.ok(!/Pose 7/.test(her.text), "a female sheet never names a male pose");
  assert.match(sheet.slots.footwear, /white sneakers/);
  assert.ok(sheet.slots.socks && sheet.slots.hair && sheet.slots.outerwear);
  const def = resolveLookSheet(base({ specOutfit: {}, backWaistbandLabel: false }));
  assert.match(def.slots.top, /short sleeves, ribbed crew neck/);
  assert.match(def.slots.footwear, /white rubber sole, flat white laces/);
});

test("keepStylingPrints=false: a photographed styling piece keeps its colour and cut, loses its print", () => {
  const off = resolveLookSheet(base());
  assert.match(off.slots.top, /^white T-shirt/);
  assert.ok(!/black text|graphic print/.test(off.slots.top), off.slots.top);
  assert.match(off.slots.top, /WITHOUT its printed text, graphics and logos/);
  const on = resolveLookSheet(base({ keepStylingPrints: true }));
  assert.match(on.slots.top, /black text and graphic print/);
  assert.match(on.slots.top, /copied FROM THE PHOTO/);
});

test("precedence: Style-with > named instruction piece > photo OUTFIT > implied instruction > default", () => {
  const style = resolveLookSheet(base({ styleWith: { footwear: "red suede loafers" }, instructionStyling: { slots: { footwear: "black boots" }, explicit: ["footwear"] } }));
  assert.match(style.slots.footwear, /^red suede loafers/);
  const named = resolveLookSheet(base({ instructionStyling: { slots: { footwear: "black low-top sneakers with black soles and black laces" }, explicit: ["footwear"] } }));
  assert.match(named.slots.footwear, /^black low-top sneakers/);
  const implied = resolveLookSheet(base({ instructionStyling: { slots: { footwear: "black boots" } } }));
  assert.match(implied.slots.footwear, /^white sneakers/);
  const gap = resolveLookSheet(base({ specOutfit: {}, instructionStyling: { slots: { footwear: "black boots" } } }));
  assert.match(gap.slots.footwear, /^black boots/);
});

test("an instruction adjustment replaces the fit words it contradicts, nothing else", () => {
  const tee = resolveLookSheet(base({ specOutfit: {}, backWaistbandLabel: false, instructionStyling: { adjust: { top: "oversized" } } }));
  assert.match(tee.slots.top, /^a heavyweight cotton t-shirt/);
  assert.match(tee.slots.top, /; oversized, as the item instruction says/);
  const legs = resolveLookSheet(base({ itemType: "TOPS", gender: "female", specOutfit: {}, backWaistbandLabel: false, instructionStyling: { adjust: { bottom: "skinny" } } }));
  assert.match(legs.slots.bottom, /^high-waisted mid-blue washed denim jeans/);
  assert.ok(!/wide|-leg|\s{2}/.test(legs.slots.bottom), legs.slots.bottom);
  const plain = resolveLookSheet(base({ itemType: "TOPS", gender: "female", specOutfit: {}, backWaistbandLabel: false }));
  assert.match(plain.slots.bottom, /^high-waisted wide-leg/);
});

test("a bodysuit is not styled with a tee over it; a bikini gets no top and no bottom", () => {
  assert.ok(!resolveLookSheet(base({ itemType: "BODYSUIT", gender: "female", specOutfit: {}, backWaistbandLabel: false })).slots.top);
  const bikini = resolveLookSheet(base({ itemType: "BIKINI", gender: "female", specOutfit: {}, backWaistbandLabel: false }));
  assert.ok(!bikini.slots.top && !bikini.slots.bottom);
  assert.match(bikini.slots.footwear, /flip-flops|bare feet/);
});

test("different panels share one sheet: the prompt carries no outfit of its own and no per-panel tuck", () => {
  const sheet = resolveLookSheet(base());
  for (const gender of ["male", "female"]) {
    for (const itemType of ["JEANS", "TOPS", "BIKINI", "SNEAKERS"]) {
      const styling: string[] = [];
      for (const p of [1, 2, 3, 4]) {
        const [poseA, poseB] = getPanelPosePair(gender, p);
        const prompt = buildMasterPanelPrompt({
          panelNumber: p,
          panelLabel: getPanelButtonLabel(gender, p),
          poseA,
          poseB,
          modelName: "Model",
          modelGender: gender,
          modelRefs: ["a", "b", "c"],
          itemRefs: ["x"],
          itemType,
          itemStyleInstructions: "STYLE IT DRESSY",
          stylingLock: withBackWaistbandVisible(buildStylingLock(itemType, gender), itemType, JAY_SPEC),
          lookSheetInServer: true,
          variationSeed: 1234 + p,
        });
        assert.ok(!/STYLING LOCK|^- TOP:|back hem sits/m.test(prompt), `${gender} ${itemType} P${p} still carries its own outfit`);
        assert.match(prompt, /OUTFIT FROM THE PHOTOS: if an item photo shows the item worn in a complete outfit/, "photographed outfit must be worn (owner rule 1)");
        assert.equal((prompt.match(/LOOK SHEET/g) ?? []).length >= 1, true);
        const lines = prompt.split("\n").filter((l) => /^(?:OUTFIT|FOOTWEAR|- Foot styling)/.test(l));
        for (const l of lines) assert.ok(!CHOICE.test(l), `choice word in styling line: ${l}`);
        styling.push(lines.join("\n"));
        const poseText = prompt.slice(prompt.indexOf("POSE GLOBAL RULES"));
        assert.ok(!MENU.test(poseText), `${gender} ${itemType} P${p} pose text still offers a menu:\n${poseText}`);
      }
      assert.equal(new Set(styling).size, 1, `${gender} ${itemType}: styling lines differ between panels`);
    }
  }
  assert.ok(sheet.text.length < 2000);
});

test("Pose 8 is the category's option, and POSE VARIATION varies inside it", () => {
  for (const gender of ["male", "female"]) {
    for (const [itemType, letter] of [["JEANS", "E"], ["TOPS", "B"], ["JACKET", "C"], ["DRESS", "B"]] as const) {
      assert.equal(pose8OptionFor(gender, itemTypeCategory(itemType)), letter);
      const [poseA, poseB] = getPanelPosePair(gender, 4);
      const prompt = buildMasterPanelPrompt({
        panelNumber: 4,
        panelLabel: "P4",
        poseA,
        poseB,
        modelName: "M",
        modelGender: gender,
        modelRefs: [],
        itemRefs: [],
        itemType,
        variationSeed: 99,
      });
      assert.match(prompt, new RegExp(`Creative pose for this product: ${letter}\\)`));
      for (const seed of [1, 2, 3, 4]) {
        const v = buildPoseVariationDirective({ modelGender: gender, poseA, poseB, seed, itemType });
        const want = { A: /seated upright/, B: /3\/4 angle/, C: /mid-step/, D: /lean/, E: /cube edge/ }[letter];
        assert.match(v, want, `${gender} ${itemType} seed ${seed}: ${v}`);
      }
    }
  }
});

test("accessory mode: the sheet replaces the styling lock and the on-model shots carry no choice", () => {
  for (const kind of ACCESSORY_KINDS) {
    for (const gender of ["male", "female"] as const) {
      const sheet = resolveLookSheet(base({ itemType: kind.toUpperCase(), gender, accessoryKind: kind, specOutfit: {}, backWaistbandLabel: false }));
      for (const p of [1, 2, 3, 4]) {
        const prompt = buildAccessoryPanelPrompt({
          kind,
          panelNumber: p,
          modelName: "M",
          modelGender: gender,
          itemType: kind.toUpperCase(),
          itemColour: "gold",
          stylingLock: buildAccessoryStylingLock(kind, gender, "gold"),
          lookSheetInServer: true,
          lookSeed: sheet.seed,
        });
        assert.ok(!/STYLING LOCK/.test(prompt), accessoryPanelLabel(p));
      }
      for (const shot of [5, 6, 7]) {
        const t = accessoryShotText(kind, shot, gender, "gold", sheet.seed);
        assert.ok(!CHOICE.test(t), `${kind} shot ${shot}: ${t}`);
      }
    }
  }
});

test("instructionHasStyling", () => {
  assert.equal(instructionHasStyling("STYLE IT DRESSY FULL OUTFIT"), true);
  assert.equal(instructionHasStyling("style with oversized streetwear tshirt and black sneakers"), true);
  assert.equal(instructionHasStyling("RELAXED FIT"), false);
  assert.equal(instructionHasStyling(""), false);
});

const ctx = (productName: string, itemType: string, over: Partial<Parameters<typeof specRiskReport>[1]> = {}) => ({
  productName,
  itemType,
  isAccessory: false,
  refCount: 6,
  ...over,
});
const codes = (r: ReturnType<typeof specRiskReport>) => [...r.blocking, ...r.warnings].map((i) => i.code);

test("spec risk: Camille Double Pleated trouser with 'no pleat' on the leg blocks", () => {
  const camille = [
    "1. Garment: pants — black.",
    "4. ZONE — WAISTBAND: 4 cm high, flat, no pleats, belt loops present.",
    "9. ZONE — FRONT OF LEG: flat, no pressed crease, no pleat.",
    "10. ZONE — BACK OF LEG: flat, no pressed crease, no pleat.",
  ].join("\n");
  const r = specRiskReport(camille, ctx("Camille Double Pleated Trouser", "PANTS"));
  assert.equal(r.blocking.length, 1);
  assert.equal(r.blocking[0].code, "name_contradiction");
  assert.equal(r.blocking[0].line, 9);
});

test("spec risk: Leopard Print Pleated Skort with a flat waistband is fine", () => {
  const skort = [
    "1. Garment: skirt — black and white.",
    "6. ZONE — WAISTBAND: about 5 cm wide, flat, no pleats.",
    "7. ZONE — FRONT OF LEG: pleated, black and white abstract pattern.",
    "12. MATERIAL/TEXTURE: lightweight, pleated fabric.",
  ].join("\n");
  const r = specRiskReport(skort, ctx("Leopard Print Pleated Skort", "SKIRT"));
  assert.deepEqual(r.blocking, []);
  assert.ok(!codes(r).includes("name_feature_unmentioned"));
});

test("spec risk: Jay Jeans 'CARRON JEANS' is a CARBON misread; CARBON itself is not", () => {
  const r = specRiskReport(JAY_SPEC, ctx("Jay Jeans", "JEANS"));
  const misread = r.warnings.filter((w) => w.code === "carbon_text_misread");
  assert.deepEqual(misread.map((w) => w.line), [4, 16]);
  // A correctly spelled CARBON quote raises nothing at all (no blanket "check the text" reminder).
  const clean = specRiskReport(JAY_SPEC.replace(/CARRON/g, "CARBON"), ctx("Jay Jeans", "JEANS"));
  assert.ok(!codes(clean).includes("carbon_text_misread"));
  assert.ok(!codes(clean).includes("text_unverified"));
});

test("spec risk: a second read that disagrees is a warning until the line is fixed", () => {
  const readings = [{ quoted: "CARRON JEANS", reading: "CARBON JEANS" }];
  const r = specRiskReport(JAY_SPEC, ctx("Jay Jeans", "JEANS", { textReadings: readings }));
  assert.equal(r.warnings.find((w) => w.code === "text_disagreement")?.line, 4);
  const fixed = specRiskReport(JAY_SPEC.replace(/CARRON/g, "CARBON"), ctx("Jay Jeans", "JEANS", { textReadings: readings }));
  assert.ok(!codes(fixed).includes("text_disagreement"));
});

test("spec risk: buttoned chest flaps raise no warning (a guess, not evidence)", () => {
  const vest = [
    "1. Garment: vest — light blue.",
    "6. ZONE — CHEST: two flap pockets with button closure.",
    "12. POCKET: flap pocket ×2, front, chest, angled flap with button closure.",
  ].join("\n");
  const r = specRiskReport(vest, ctx("Denim Vest", "VEST"));
  assert.equal(r.warnings.length, 0, JSON.stringify(r.warnings));
});

test("spec risk: Wayne's styling tank text is flagged; the analyzer no longer locks it", () => {
  const wayne = [
    "1. Garment: overall — black.",
    '4. TEXT (exact spelling, case and letterforms): "CAME" at front, top_under, bold, italic, blue — applied as screen print. Reproduce verbatim — never paraphrase, translate, drop, or add letters.',
    "26. OUTFIT — TOP UNDER: black sleeveless top with blue text print.",
  ].join("\n");
  const r = specRiskReport(wayne, ctx("Wayne Overall", "OVERALL"));
  assert.equal(r.warnings.find((x) => x.code === "styling_text_locked")?.line, 4);
  const lock = buildLockText({ garment_type: "overall", colorway: "black", text: [{ text: "CAME", placement: "front, top_under" }] });
  assert.ok(!/CAME/.test(lock), lock);
});

test("spec risk: one-photo accessory warnings", () => {
  const anklet = [
    "1. Garment: anklet — gold, multicolored.",
    "5. ZONE — BEADS OR STONES: three groups of beads: one group with two small blue faceted beads.",
    "6. ZONE — CHARM OR PENDANT: four small round gold disc charms, evenly spaced between bead groups.",
  ].join("\n");
  const r = specRiskReport(anklet, ctx("Anklet E", "ANKLET", { isAccessory: true, refCount: 1 }));
  assert.ok(codes(r).includes("accessory_single_photo"));
  assert.equal(r.warnings.find((x) => x.code === "accessory_counts")?.line, 5);
  assert.ok(!codes(specRiskReport(anklet, ctx("Anklet E", "ANKLET", { isAccessory: true, refCount: 3 }))).includes("accessory_single_photo"));
});

test("lock text: surface, distressing map (mirrored in code) and the bead sequence", () => {
  const lock = buildLockText({
    garment_type: "jeans",
    materials_texture: "denim",
    surface: "matte, twill",
    distressing: "rips",
    distressing_map: [{ side: "front", where: "image-left leg", height: "knee", kind: "open rip with white threads across", size: "about half the leg width", count: 1 }],
  });
  assert.match(lock, /MATERIAL\/TEXTURE: denim — surface: matte, twill\./);
  assert.match(lock, /DISTRESSING \(front, the wearer's right leg, knee\): open rip with white threads across, about half the leg width\./);
  assert.match(lock, /DISTRESSING: nowhere else/);
  const acc = buildLockText({ garment_type: "anklet", sequence: "clasp → gold disc ×1 → tube bead ×4 → spacer ×1" }, { accessory: true });
  assert.match(acc, /SEQUENCE \(from the clasp, all the way round\): clasp → gold disc ×1/);
});
