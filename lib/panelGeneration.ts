/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared panel-generation logic for the OpenAI generators.
//
// These pure helpers are ported verbatim from components/studio-workspace.tsx so the
// new "OpenAI V2 Generator" page can reuse the exact same prompt-building, pose-pairing,
// item-type, and 3:4-split behavior WITHOUT modifying the existing generator page.
// Keep this file behavior-identical to the originals; the live studio page is the source of truth.

import { getPoseLibraryForGender } from "@/lib/panelPoseLibraries";

export const SPLIT_TARGET_WIDTH = 900;
export const SPLIT_TARGET_HEIGHT = 1200;

export type SensitivityTier = "low" | "medium" | "high";

export function normalizePromptInstruction(value: unknown, maxLen = 1200) {
  return String(value || "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, maxLen);
}

export function normalizeItemType(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function isSwimwearItemType(value: string) {
  const t = String(value || "").trim().toLowerCase();
  if (!t) return false;
  return (
    t.includes("swimwear") ||
    t.includes("swim short") ||
    t.includes("swimshort") ||
    t.includes("swim trunk") ||
    t.includes("swim trunks") ||
    t.includes("bikini") ||
    t.includes("one-piece swimsuit") ||
    t.includes("one piece swimsuit") ||
    t.includes("swimsuit")
  );
}

// App-level safety categorization. Separate from the prompt; use it to block categories
// you never want the generator to attempt.
export function getSensitivityTier(itemTypeValue: string, modelGender: string): SensitivityTier {
  const t = normalizeItemType(itemTypeValue);
  void modelGender;
  const highMatchers = [
    "underwear",
    "underwear set",
    "briefs",
    "brief",
    "boxer briefs",
    "boxers",
    "lingerie",
    "thong",
    "bra",
    "intimates",
  ];
  if (highMatchers.some((m) => t.includes(m))) return "high";
  if (
    isSwimwearItemType(t) ||
    t.includes("swim trunks") ||
    t.includes("swim trunk") ||
    t.includes("swim shorts")
  ) {
    return "medium";
  }
  return "low";
}

export function getSwimwearStyleLockLines(gender: string, itemTypeValue: string) {
  if (!isSwimwearItemType(itemTypeValue)) return [] as string[];
  const g = String(gender || "").trim().toLowerCase();
  const lines = [
    "SWIMWEAR SAFETY + STYLING LOCK (NON-NEGOTIABLE):",
    "- Keep the scene strictly ecommerce/catalog, neutral posture, and non-suggestive styling.",
    "- Keep the styling neutral, professional, and non-suggestive.",
    "- Use clean studio product-photography styling only.",
    "- Foot styling for swimwear: use clean flip-flops/sandals/water-shoes, or naturally uncovered feet when needed.",
  ];
  if (g === "male") {
    lines.push(
      "- Male swimwear rule: standard commercial swimwear presentation is allowed in neutral catalog styling."
    );
  } else if (g === "female") {
    lines.push(
      "- Female swimwear rule: keep standard swimwear coverage consistent with item references and neutral catalog styling."
    );
  }
  return lines;
}

export function isFemaleDressPanelBlocked(
  _modelGender: string,
  _itemTypeValue: string,
  _panelNumber: number
) {
  return false;
}

export function getPanelPosePair(gender: string, panelNumber: number): [number, number] {
  const g = String(gender || "").toLowerCase();
  if (g === "female") {
    if (panelNumber === 1) return [1, 2];
    if (panelNumber === 2) return [3, 4];
    if (panelNumber === 3) return [7, 5];
    return [6, 8];
  }
  if (panelNumber === 1) return [1, 2];
  if (panelNumber === 2) return [3, 4];
  if (panelNumber === 3) return [5, 6];
  return [7, 8];
}

export function getPanelButtonLabel(gender: string, panelNumber: number) {
  const [poseA, poseB] = getPanelPosePair(gender, panelNumber);
  return `Panel ${panelNumber} (Pose ${poseA} + ${poseB})`;
}

export function uniqueSortedPanels(values: number[]) {
  return Array.from(new Set(values)).sort((a, b) => a - b);
}

export function buildPanelLockKey(modelId: string, itemTypeValue: string, refs: string[]) {
  const normalizedRefs = [...refs]
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .sort();
  return [modelId.trim(), itemTypeValue.trim().toLowerCase(), normalizedRefs.join("|")].join("::");
}

function inferItemTypeCategory(itemTypeValue: string) {
  const t = String(itemTypeValue || "").trim().toLowerCase();
  if (!t) return "item";
  // Word-start matches: plain substrings made "sunset tee" and "corset top" a
  // full look (…set…) and "overshirt" a top.
  const has = (...keywords: string[]) => keywords.some((kw) => new RegExp(`\\b${kw}`).test(t));
  if (
    has(
      "full look",
      "full-look",
      "outfit",
      "set",
      "matching set",
      "two piece",
      "two-piece",
      "co-ord",
      "co ord"
    )
  ) {
    return "full-look";
  }
  if (
    has(
      "shirt",
      "tee",
      "t-shirt",
      "tshirt",
      "tank",
      "top",
      "blouse",
      "hoodie",
      "crewneck",
      "sweatshirt",
      "sweater",
      "polo",
      "jersey",
      "vest",
      "cardigan",
      "button-down",
      "button down"
    )
  ) {
    return "top";
  }
  if (has("dress", "jumpsuit", "romper", "overall", "overalls", "one-piece")) {
    return "full-look";
  }
  if (
    has(
      "pant",
      "pants",
      "jean",
      "jeans",
      "short",
      "shorts",
      "skirt",
      "legging",
      "jogger",
      "cargo",
      "trouser",
      "bottom"
    )
  ) {
    return "bottom";
  }
  if (has("shoe", "sneaker", "boot", "heel", "sandal", "loafer", "trainer", "footwear")) {
    return "footwear";
  }
  if (has("jacket", "coat", "puffer", "overshirt", "outerwear", "windbreaker", "blazer")) {
    return "outerwear";
  }
  if (
    has(
      "bag",
      "hat",
      "cap",
      "belt",
      "scarf",
      "sock",
      "socks",
      "accessory",
      "jewelry",
      "jewellery",
      "watch",
      "glove",
      "gloves"
    )
  ) {
    return "accessory";
  }
  return "item";
}

export function getCloseUpCategoryRule(itemTypeValue: string) {
  const category = inferItemTypeCategory(itemTypeValue);
  if (category === "top") {
    return [
      "- Category lock: close-up must focus on TOP details only (not shorts/pants/shoes).",
      "- Close-up safety lock: keep the crop product-focused and non-suggestive.",
      "- Prefer safe conversion details: logo/patch/print edges, collar/neckline seam, shoulder seam, sleeve cuff, hem stitching, buttons/snaps/zips, fabric weave/texture in a non-revealing area.",
    ].join("\n");
  }
  if (category === "bottom") {
    return "- Category lock: close-up must focus on BOTTOM details only (not tops/shoes).";
  }
  if (category === "footwear") {
    return "- Category lock: close-up must focus on FOOTWEAR details only.";
  }
  if (category === "outerwear") {
    return "- Category lock: close-up must focus on OUTERWEAR details only.";
  }
  if (category === "accessory") {
    return "- Category lock: close-up must focus on ACCESSORY details only.";
  }
  if (category === "full-look") {
    return [
      "- Category lock: choose the highest-detail hero component from the locked full look and keep the rest of the look unchanged.",
      "- Close-up safety lock: keep the crop product-only (fabric/hardware/branding/seams) and non-suggestive.",
    ].join("\n");
  }
  return "- Category lock: close-up must focus on the exact item type entered in section 0.5.";
}

/** Poses the libraries define as a waist-to-feet LEGS crop (they were written for
 *  bottoms): male Pose 5, female Pose 7. */
export function isLegsCropPose(gender: string, pose: number) {
  const p = Number(pose);
  return String(gender || "").trim().toLowerCase() === "female" ? p === 7 : p === 5;
}

/** Tops / outerwear live above the waist, so the legs crop would photograph the
 *  stylist's shorts instead of the product (SIMPLIFY tee, 2026-08-26). For these
 *  categories the legs-crop pose is swapped for an upper-body product crop. */
export function isUpperBodyProductCategory(itemTypeValue: string) {
  const c = inferItemTypeCategory(itemTypeValue);
  return c === "top" || c === "outerwear";
}

export function getUpperBodyCropPoseBlock(poseNumber: number) {
  return [
    `POSE ${poseNumber} - Upper Body / Torso Product Crop (TOPS VARIANT — replaces the library's Lower Body / Legs definition because the locked item is a top / outerwear)`,
    "Base",
    "- Crop: neckline to just below the garment hem. The head is OUT of frame (crop at the chin / neck line); everything below the hem (hips, shorts/pants, legs, shoes) is OUT of frame.",
    "- Front-facing, body square to camera, even weight; arms relaxed at the sides so the whole garment body, both sleeves and the hem are visible.",
    "- Emphasize fit and construction: shoulder-seam drop, chest/body width, sleeve length and cuff, hem finish, neckline rib, fabric drape and texture.",
    "- Any front chest / sleeve text, logo or graphic must be fully visible, sharp, letter-perfect and never covered by hands.",
    "Variation Options (pick ONE)",
    `- ${poseNumber}A: Arms straight down, hands just out of frame (cleanest)`,
    `- ${poseNumber}B: Slight 10 deg body turn to show the side seam`,
    `- ${poseNumber}C: One hand resting lightly at the hem (no pulling, no covering print)`,
  ].join("\n");
}

/** The active pose block for a prompt: the library text, except that the legs
 *  crop becomes the upper-body product crop for tops / outerwear. */
export function getEffectivePoseBlock(library: string, gender: string, poseNumber: number, itemTypeValue: string) {
  if (isLegsCropPose(gender, poseNumber) && isUpperBodyProductCategory(itemTypeValue)) {
    return getUpperBodyCropPoseBlock(poseNumber);
  }
  return extractPoseBlock(library, poseNumber);
}

function upperBodyCropLockLine(poseNumber: number) {
  return `- LEFT Pose ${poseNumber} is an UPPER-BODY PRODUCT crop (neckline to hem) of the locked top, NOT a full body and NOT a legs crop. HARD CROP LOCK: the head/face is OUT of frame (crop at the neck) and everything below the garment hem (shorts/pants/legs/shoes) is OUT of frame. Fill the frame with the top: shoulders, chest, both sleeves, hem, with any front text/graphic sharp and fully visible. A waist-to-feet legs crop or a full standing body is WRONG.`;
}

/**
 * What is specific to THIS panel's two poses and nothing else: which side is
 * which, the crop each side must obey, and (Panel 3) what the close-up is of.
 * Age, footwear, identity, the back design and the outfit are stated once
 * elsewhere in the prompt — restating them here per panel is how the prompt
 * grew to 29 KB of the same rule in eight voices.
 */
export function getPanelCriticalLockLines(gender: string, panelNumber: number, itemTypeValue = "") {
  const lockedItemType = String(itemTypeValue || "").trim();
  const upperBodyItem = isUpperBodyProductCategory(lockedItemType);
  const normalizedItemType =
    String(gender || "").trim().toLowerCase() === "female" && isSwimwearItemType(lockedItemType)
      ? "swimwear"
      : lockedItemType;
  const closeUpSubjectLine = normalizedItemType
    ? `- The close-up shows the "${normalizedItemType}" only — the most detailed part of this exact item (if several items are present, the most detailed one that is still this item type).`
    : "- The close-up shows the locked item type only, at its most detailed part.";
  const closeUpCategoryRule = getCloseUpCategoryRule(lockedItemType);
  const legsCropLine = (pose: number) =>
    upperBodyItem
      ? upperBodyCropLockLine(pose)
      : `- LEFT Pose ${pose} is a LEGS-ONLY crop (waist to feet) OF THE MODEL WEARING IT, NOT a full body and NOT a product-only shot. HARD CROP LOCK: the head, face, chest, and upper torso MUST be entirely OUT of frame — the frame starts at the waistband and ends at the feet. The model's own legs fill the garment and their shoes are on their feet at the very bottom. Fill the frame with the lower body (waistband + closure, front rise, pockets, thighs, hem). A full standing body, a visible head/torso, or an empty garment with nobody in it is WRONG.`;
  const g = String(gender || "").toLowerCase();
  if (g === "female") {
    if (panelNumber === 1) {
      return [
        "PANEL 1 (Pose 1 + Pose 2):",
        "- LEFT Pose 1: full-body front hero, head and feet fully visible.",
        "- RIGHT Pose 2: full-body BACK view, face visible over the shoulder.",
      ];
    }
    if (panelNumber === 2) {
      return [
        "PANEL 2 (Pose 3 + Pose 4):",
        "- LEFT Pose 3: full-body 3/4 front angle (25-35 degrees).",
        "- RIGHT Pose 4: upper body with the face visible, cropped exactly as the pose defines.",
        "- Do not swap sides and do not replace either side with another pose.",
      ];
    }
    if (panelNumber === 3) {
      return [
        "PANEL 3 (Pose 7 + Pose 5):",
        legsCropLine(7),
        "- RIGHT Pose 5: one close-up of this same look, ON the model — fabric on the body, never a product-only still.",
        closeUpSubjectLine,
        closeUpCategoryRule,
      ];
    }
    return [
      "PANEL 4 (Pose 6 + Pose 8):",
      "- LEFT Pose 6: relaxed full-body front, face visible.",
      "- RIGHT Pose 8: one controlled creative shot of this same look.",
    ];
  }
  if (panelNumber === 1) {
    return [
      "PANEL 1 (Pose 1 + Pose 2):",
      "- LEFT Pose 1: full-body front neutral hero, straight-on camera.",
      "- RIGHT Pose 2: full-body FRONT-FACING lifestyle with a subtle weight shift only (face to camera; NOT a back view, NOT over-the-shoulder).",
      "- Both frames show the full head and both feet. Do not rotate the LEFT frame into a lifestyle angle; do not replace the RIGHT frame with a torso crop.",
    ];
  }
  if (panelNumber === 2) {
    return [
      "PANEL 2 (Pose 3 + Pose 4):",
      "- LEFT Pose 3: torso + head front crop (mid-thigh to head).",
      "- RIGHT Pose 4: full-body BACK view with the full head and feet visible.",
      "- Do not swap sides.",
    ];
  }
  if (panelNumber === 3) {
    return [
      "PANEL 3 (Pose 5 + Pose 6):",
      legsCropLine(5),
      "- RIGHT Pose 6: one close-up detail of this same item, ON the model — fabric on the body, never a product-only still.",
      closeUpSubjectLine,
      closeUpCategoryRule,
    ];
  }
  return [
    "PANEL 4 (Pose 7 + Pose 8):",
    "- LEFT Pose 7 is a TORSO-BACK crop (mid-thigh to head), back-facing, with an over-the-shoulder head turn — NOT a full body. HARD CROP LOCK: crop the frame at mid-thigh; the lower legs and feet MUST be OUT of frame. If a full head-to-toe standing body appears, it is WRONG and must be re-framed as a mid-thigh-to-head crop.",
    "- RIGHT Pose 8: one controlled creative pose of this same look.",
  ];
}

/**
 * Everything the model wears that is NOT the product.
 *
 * Four panels are four independent API calls that share no memory, so "the
 * same shoes across the whole run" was an instruction nothing could obey:
 * each call invented its own sneakers and its own t-shirt, and a set came
 * back styled four different ways. The complementary pieces are therefore
 * NAMED — the same words in every panel of every run — so consistency comes
 * from the prompt instead of from hope.
 *
 * It never overrides the item photos: it supplies only the pieces they do not
 * show.
 */
export function buildStylingLock(itemTypeValue: string, gender: string): string {
  const female = String(gender || "").trim().toLowerCase() === "female";
  const category = inferItemTypeCategory(itemTypeValue);
  const swim = isSwimwearItemType(itemTypeValue);

  const shoes = swim
    ? "- FOOTWEAR: plain black flip-flops, or naturally bare feet. The same choice in every frame."
    : "- FOOTWEAR: plain white low-top leather sneakers — flat white laces, plain white rubber soles, no visible branding, no contrast panels. The exact same pair in every frame, both feet identical.";
  const socks = swim ? "" : "- SOCKS: plain white no-show socks, never visible above the shoe.";
  const top = female
    ? "- TOP: a plain black fitted crew-neck short-sleeve t-shirt, untucked — no print, no logo, no pocket, no graphic."
    : "- TOP: a plain black crew-neck short-sleeve cotton t-shirt, untucked — no print, no logo, no pocket, no graphic.";
  const bottom = female
    ? "- BOTTOM: plain black slim full-length trousers — no print, no logo, no visible hardware."
    : "- BOTTOM: plain mid-grey slim straight full-length trousers — no print, no logo, no visible hardware.";
  const accessories =
    "- ACCESSORIES: none at all — no watch, no jewellery, no belt, no hat, no sunglasses, no bag, no visible socks logo.";

  const lines: string[] = [];
  if (category === "top" || category === "outerwear") lines.push(bottom);
  else if (category === "bottom") lines.push(top);
  else if (category === "footwear" || category === "accessory") lines.push(top, bottom);
  else if (category === "full-look") {
    /* The look is complete in the photos; only the parts it cannot show. */
  } else lines.push(top);
  if (category === "outerwear") lines.push(top.replace("- TOP:", "- TOP UNDER THE OUTERWEAR:"));
  if (category !== "footwear") lines.push(shoes);
  if (socks && category !== "footwear") lines.push(socks);
  lines.push(accessories);
  return lines.join("\n");
}

/**
 * The library's shared preamble — background, lighting, styling, expression —
 * without any individual pose.
 *
 * The whole library used to be pasted into every prompt "for reference":
 * 7.8 KB male / 8.6 KB female, against 958 bytes for the two poses the panel
 * actually renders. A quarter of each prompt therefore described SIX poses
 * that panel would never produce, carrying their own crop locks, framing rules
 * and back-view instructions — instructions that compete with the two active
 * ones. The active poses are injected separately as LEFT/RIGHT ACTIVE POSE, so
 * the library added nothing but contradiction and bytes.
 */
export function extractGlobalRules(library: string) {
  const lib = String(library || "");
  // Everything before the first pose header; the header shapes are the same
  // ones extractPoseBlock matches.
  const cut = lib.search(/\n\s*(?:FEMALE\s*[-—]\s*)?POSE\s+\d+\s/i);
  // A library with no recognisable header would otherwise dump itself back in.
  if (cut <= 0) return "";
  // Drop the decorative banner and the "FEMALE POSE SET … 1 to 8" title —
  // they name eight poses the panel will not render.
  return lib
    .slice(0, cut)
    .split("\n")
    .filter((l) => !/^\s*=+\s*$/.test(l) && !/POSE SET\b/i.test(l))
    .join("\n")
    .trim();
}

export function extractPoseBlock(library: string, poseNumber: number) {
  const lib = String(library || "");
  const n = Number.isFinite(poseNumber) ? Math.trunc(poseNumber) : poseNumber;
  // A block ends at the NEXT header of either shape. The female library's last
  // header is "FEMALE - POSE 8:", which the old plain "POSE n " lookahead did
  // not recognise — so female Pose 7 ran to the end of the file and carried the
  // whole Pose 8 creative block (seated / walking variants) into a legs crop.
  const nextHeader = `\\n\\s*(?:FEMALE\\s*[-—]\\s*)?POSE\\s+\\d+\\b`;
  const patterns = [
    new RegExp(`(?:^|\\n\\s*)(POSE\\s+${n}\\s+[\\s\\S]*?)(?=${nextHeader}|$)`, "i"),
    new RegExp(`(?:^|\\n\\s*)(FEMALE\\s*[-—]\\s*POSE\\s+${n}\\b[\\s\\S]*?)(?=${nextHeader}|$)`, "i"),
  ];
  for (const regex of patterns) {
    const match = lib.match(regex);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return `POSE ${poseNumber}`;
}

/** Premium/editorial facial expressions. One is picked per generation run so the
 *  same model doesn't wear an identical robotic expression across products. */
export const EXPRESSION_DIRECTIVES = [
  "a relaxed neutral look with soft, warm eyes and lips gently closed",
  "a subtle closed-mouth smile, calm and quietly confident",
  "a light, natural half-smile with relaxed brows",
  "a composed, confident expression with a faint, easy smile",
  "an approachable soft smile with no teeth, eyes softly engaged",
  "a serene, premium expression with a gentle, self-assured gaze",
  "a quiet confident look with a relaxed jaw and calm, steady eyes",
  "a warm, friendly expression with softly smiling eyes",
];

/** Pick one expression cue at random (call once per generation run). */
export function pickExpressionDirective(): string {
  return EXPRESSION_DIRECTIVES[Math.floor(Math.random() * EXPRESSION_DIRECTIVES.length)];
}

export function buildMasterPanelPrompt(args: {
  panelNumber: number;
  panelNumberForLocks?: number;
  panelLabel: string;
  poseA: number;
  poseB: number;
  modelName: string;
  modelGender: string;
  modelRefs: string[];
  itemRefs: string[];
  itemType: string;
  itemStyleInstructions?: string;
  /** Per-generation facial-expression cue (varies run-to-run so models don't look robotic). */
  expressionDirective?: string;
  /** The non-product styling, identical across the run. Defaults per item type. */
  stylingLock?: string;
}) {
  /*
   * One rule, one voice. The previous builder said "the model is over 25" in
   * seven places, "shoes must be visible" in six, "keep the back clean" in
   * four (one of them unconditionally), and named both genders' poses on
   * every run — 22–29 KB that the image model had to reconcile before it
   * could start on the garment. Identity, background, the item-type focus,
   * the verified item spec, the back-design state and brand safety are the
   * server's (app/api/generate/route.ts) and are stated exactly once there;
   * this is the scene, the product-fidelity rule, and the two active poses.
   */
  const gender = String(args.modelGender || "").trim().toLowerCase() === "female" ? "female" : "male";
  const poseLibrary = getPoseLibraryForGender(args.modelGender);
  // Shared styling rules only — never the other six poses. See extractGlobalRules.
  const globalRules = extractGlobalRules(poseLibrary);
  const poseABlock = getEffectivePoseBlock(poseLibrary, args.modelGender, args.poseA, args.itemType);
  const poseBBlock = getEffectivePoseBlock(poseLibrary, args.modelGender, args.poseB, args.itemType);
  const upperBodyItem = isUpperBodyProductCategory(args.itemType);
  const legsCropOverrideActive =
    upperBodyItem &&
    (isLegsCropPose(args.modelGender, args.poseA) || isLegsCropPose(args.modelGender, args.poseB));
  const criticalLockLines = getPanelCriticalLockLines(
    args.modelGender,
    args.panelNumberForLocks ?? args.panelNumber,
    args.itemType
  );
  const swimwearActive = isSwimwearItemType(args.itemType);
  const swimwearStyleLines = getSwimwearStyleLockLines(args.modelGender, args.itemType);
  const promptItemType = gender === "female" && swimwearActive ? "swimwear" : args.itemType.trim();
  const itemLabel = promptItemType || "apparel item";
  const styleInstructions = normalizePromptInstruction(args.itemStyleInstructions);
  /* Named, not described: the four panels cannot see each other's choices. */
  const stylingLock = args.stylingLock?.trim() || buildStylingLock(args.itemType, args.modelGender);
  const expressionDirective =
    normalizePromptInstruction(args.expressionDirective, 240) ||
    "a natural, relaxed premium expression with soft, warm eyes";
  const modelLabel = `${args.modelName || "the locked model"} (${args.modelGender || "model"})`;

  return [
    `Professional ecommerce catalog photo shoot. Panel ${args.panelNumber} (${args.panelLabel}). Model: ${modelLabel}. Item type: ${itemLabel}.`,
    "LAYOUT: output exactly one 1536x1024 image — the LEFT half (768x1024) is Pose A, the RIGHT half (768x1024) is Pose B, with a thin divider between them and nothing else: no third pose, no collage, no grid, no text overlay.",
    "ITEM REFERENCES: the item photos are product references only. Take the garment's shape, colour, material, construction and every detail from them. Any person, mannequin or hanger in an item photo is a display fixture — never copy a face, hair, skin tone, body, age, tattoos, jewellery, pose or styling from an item photo; the person in every frame is the model from the MODEL references.",
    "If the item photos show a complete outfit, reproduce the whole outfit (top, bottom, shoes, accessories) unchanged in every frame. Anything the photos do NOT show comes from the STYLING LOCK below — never invent branded or designed pieces, prints, logos or accessories.",
    "STYLING LOCK — everything that is NOT the product. Use these exact pieces, worded exactly as written, in this frame and in every other panel of this run; they are what keeps the set looking like one shoot. If the item photos show that piece, the photos win instead:",
    stylingLock,
    "WORN BY THE MODEL: every frame shows the garment ON the living model from the MODEL references — the model's own body inside the clothes, their legs in the trousers, their skin at the ankle and wrist. A cropped frame still contains their body. Never a flat lay, never a ghost mannequin, never an empty garment floating on the background, never a frame with no person in it.",
    `GARMENT FIDELITY: the ${itemLabel} is the exact product in the item photos — identical cut and fit (a slim fit stays slim, an oversized fit stays oversized; never lengthen, shorten, loosen or tighten it), identical colour, wash, material and texture, identical seams, stitching, pockets, hardware, closures, hems and cuffs, identical distressing in the same places, and every logo, text, print and graphic at the same size, position, colours and print effect. Never redesign, simplify, recolour, move, resize, mirror or add anything. It stays identical in both frames and across every panel of this run.`,
    ...(styleInstructions
      ? ["STYLING INSTRUCTIONS (apply while keeping the product identical):", styleInstructions]
      : []),
    swimwearActive
      ? "FOOTWEAR: full-body frames use the sandals named in the styling lock, or naturally uncovered feet."
      : "FOOTWEAR: every full-body frame shows the exact shoes named in the styling lock, on both feet. Never barefoot, never socks-only, never a different pair from the other panels.",
    `EXPRESSION for this generation: ${expressionDirective}. The face looks alive and human, with subtle natural variation between the two frames; expression changes only the mouth, eye warmth, brow and gaze — never face geometry, age, skin tone or hairline.`,
    "Photorealistic: real human anatomy and skin texture; no CGI, plastic or mannequin look.",
    ...(globalRules
      ? [`${gender === "female" ? "FEMALE" : "MALE"} POSE GLOBAL RULES (apply to both poses):`, globalRules]
      : []),
    ...criticalLockLines,
    ...swimwearStyleLines,
    `LEFT ACTIVE POSE (Pose ${args.poseA}):\n${poseABlock}`,
    `RIGHT ACTIVE POSE (Pose ${args.poseB}):\n${poseBBlock}`,
    ...(legsCropOverrideActive
      ? [
          "TOPS OVERRIDE (this generation): the locked item is a top / outerwear, so the library's 'Lower Body / Legs' definition for the active crop pose is REPLACED by the 'Upper Body / Torso Product Crop' block given as the ACTIVE POSE above. Do NOT photograph the legs, shorts or pants in that frame — the product is the top.",
        ]
      : []),
    "FRAMING: a full-body pose shows the whole body from the top of the hair to the soles of the shoes with white margin above and below — zoom out rather than crop. A crop pose follows its crop exactly as defined above, and the out-of-frame body parts stay out of frame. Keep each pose centred in its own half; each half is a 3:4 portrait.",
  ].join("\n");
}

// ---- client-only image helpers (DOM canvas) ----

function loadImageSource(src: string, errorMessage: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(errorMessage));
    img.src = src;
  });
}

export function loadBase64Image(b64: string) {
  return loadImageSource(`data:image/png;base64,${b64}`, "Failed to load generated panel image");
}

// Splits a 2-up 1536x1024 panel into left/right strict-3:4 portrait crops (base64, no data: prefix).
export async function splitPanelToThreeByFour(
  b64: string
): Promise<{ left: string; right: string }> {
  const img = await loadBase64Image(b64);
  const halfW = Math.floor(img.width / 2);
  const halfH = img.height;
  const targetRatio = SPLIT_TARGET_WIDTH / SPLIT_TARGET_HEIGHT;

  const capX = Math.floor(halfW * 0.08);
  const capY = Math.floor(halfH * 0.08);
  // Small base inset on every edge (kills thin anti-aliased hairlines the detector
  // might miss) and a larger GUARANTEED trim on the seam/inner edge, where the
  // divider between the two frames always sits — removed even when it's a soft grey.
  const baseInset = Math.max(3, Math.round(halfW * 0.006));
  const seamTrim = Math.max(9, Math.round(halfW * 0.016));

  // Depth of the contiguous dark band running inward from each edge (0 if none).
  function darkEdgeDepths(sideOffsetX: number): { left: number; right: number; top: number; bottom: number } {
    const zero = { left: 0, right: 0, top: 0, bottom: 0 };
    const probe = document.createElement("canvas");
    probe.width = halfW;
    probe.height = halfH;
    const pctx = probe.getContext("2d", { willReadFrequently: true });
    if (!pctx) return zero;
    pctx.drawImage(img, sideOffsetX, 0, halfW, halfH, 0, 0, halfW, halfH);
    let data: Uint8ClampedArray;
    try {
      data = pctx.getImageData(0, 0, halfW, halfH).data;
    } catch {
      return zero; // tainted canvas — skip detection
    }
    const LUM = 55; // average luminance below this = "dark" (catches grey dividers)
    const COV = 0.72; // fraction of the line that must be dark
    const darkCol = (x: number) => {
      let dark = 0, n = 0;
      for (let y = 0; y < halfH; y += 2, n++) {
        const i = (y * halfW + x) * 4;
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 < LUM) dark++;
      }
      return n > 0 && dark >= n * COV;
    };
    const darkRow = (y: number) => {
      let dark = 0, n = 0;
      for (let x = 0; x < halfW; x += 2, n++) {
        const i = (y * halfW + x) * 4;
        if ((data[i] + data[i + 1] + data[i + 2]) / 3 < LUM) dark++;
      }
      return n > 0 && dark >= n * COV;
    };
    const d = { left: 0, right: 0, top: 0, bottom: 0 };
    while (d.left < capX && darkCol(d.left)) d.left++;
    while (d.right < capX && darkCol(halfW - 1 - d.right)) d.right++;
    while (d.top < capY && darkRow(d.top)) d.top++;
    while (d.bottom < capY && darkRow(halfH - 1 - d.bottom)) d.bottom++;
    return d;
  }

  function cropForSide(side: "left" | "right") {
    const sideOffsetX = side === "left" ? 0 : img.width - halfW;
    const d = darkEdgeDepths(sideOffsetX);
    let tL = Math.max(baseInset, d.left);
    let tR = Math.max(baseInset, d.right);
    let tT = Math.max(baseInset, d.top);
    let tB = Math.max(baseInset, d.bottom);
    // Guarantee the divider seam is gone: left crop's seam is its RIGHT edge, the
    // right crop's seam is its LEFT edge.
    if (side === "left") tR = Math.max(tR, seamTrim);
    else tL = Math.max(tL, seamTrim);
    // Safety: never eat more than ~45% of a dimension (protects dark-clothed models).
    if (tL + tR > halfW * 0.45) { tL = side === "left" ? baseInset : seamTrim; tR = side === "left" ? seamTrim : baseInset; }
    if (tT + tB > halfH * 0.45) { tT = baseInset; tB = baseInset; }

    const region = { x: tL, y: tT, w: halfW - tL - tR, h: halfH - tT - tB };
    // Center-crop the trimmed region to the 3:4 target.
    let srcX = sideOffsetX + region.x;
    let srcY = region.y;
    let srcW = region.w;
    let srcH = region.h;
    const sourceRatio = region.w / region.h;

    if (sourceRatio > targetRatio) {
      srcW = Math.max(1, Math.round(region.h * targetRatio));
      srcX = sideOffsetX + region.x + Math.floor((region.w - srcW) / 2);
    } else if (sourceRatio < targetRatio) {
      srcH = Math.max(1, Math.round(region.w / targetRatio));
      srcY = region.y + Math.floor((region.h - srcH) / 2);
    }

    const canvas = document.createElement("canvas");
    canvas.width = SPLIT_TARGET_WIDTH;
    canvas.height = SPLIT_TARGET_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to initialize crop canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, SPLIT_TARGET_WIDTH, SPLIT_TARGET_HEIGHT);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, SPLIT_TARGET_WIDTH, SPLIT_TARGET_HEIGHT);
    const dataUrl = canvas.toDataURL("image/png");
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  }

  return { left: cropForSide("left"), right: cropForSide("right") };
}
