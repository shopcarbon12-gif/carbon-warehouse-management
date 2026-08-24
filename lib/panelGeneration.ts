/* eslint-disable @typescript-eslint/no-explicit-any */
// Shared panel-generation logic for the OpenAI generators.
//
// These pure helpers are ported verbatim from components/studio-workspace.tsx so the
// new "OpenAI V2 Generator" page can reuse the exact same prompt-building, pose-pairing,
// item-type, and 3:4-split behavior WITHOUT modifying the existing generator page.
// Keep this file behavior-identical to the originals; the live studio page is the source of truth.

import {
  FEMALE_PANEL_MAPPING_TEXT,
  MALE_PANEL_MAPPING_TEXT,
  getPoseLibraryForGender,
} from "@/lib/panelPoseLibraries";

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
  const has = (...keywords: string[]) => keywords.some((kw) => t.includes(kw));
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

export function getPanelCriticalLockLines(gender: string, panelNumber: number, itemTypeValue = "") {
  const panelAdultLock = "- HARD AGE LOCK: the model is over 25+.";
  const lockedItemType = String(itemTypeValue || "").trim();
  const normalizedItemType =
    String(gender || "").trim().toLowerCase() === "female" && isSwimwearItemType(lockedItemType)
      ? "swimwear"
      : lockedItemType;
  const swimwearActive = isSwimwearItemType(lockedItemType);
  const footwearHardLockLine = swimwearActive
    ? "- Swimwear footwear lock: full-body frames may use flip-flops/water-shoes, or naturally uncovered feet."
    : "- Footwear hard lock: both full-body frames must show shoes. Barefoot is forbidden.";
  const footwearWhenFullBodyLine = swimwearActive
    ? "- Swimwear footwear lock: when a frame is full-body, use flip-flops/water-shoes, or naturally uncovered feet."
    : "- Footwear hard lock: when a frame is full-body, shoes must be worn and visible.";
  const closeUpSubjectLine = normalizedItemType
    ? `- CLOSE-UP SUBJECT LOCK: section 0.5 item type is "${normalizedItemType}". Close-up must show this item type only.`
    : "- CLOSE-UP SUBJECT LOCK: close-up must follow section 0.5 item type only.";
  const closeUpCategoryRule = getCloseUpCategoryRule(lockedItemType);
  const g = String(gender || "").toLowerCase();
  if (g === "female") {
    if (panelNumber === 1) {
      return [
        "FEMALE PANEL 1 CRITICAL LOCK (Pose 1 + Pose 2):",
        panelAdultLock,
        "- LEFT Pose 1 must be full-body front hero with head and feet fully visible.",
        "- RIGHT Pose 2 must be full-body back view with face visible over shoulder.",
        footwearHardLockLine,
        "- Same exact model identity and same selected look in both frames.",
      ];
    }
    if (panelNumber === 2) {
      return [
        "FEMALE PANEL 2 CRITICAL LOCK (Pose 3 + Pose 4):",
        panelAdultLock,
        "- LEFT Pose 3 must be full-body 3/4 front angle (25-35 degrees).",
        "- RIGHT Pose 4 must be upper-body with face visible; crop must match pose definition.",
        "- Do not swap sides, do not replace either side with another pose.",
      ];
    }
    if (panelNumber === 3) {
      return [
        "FEMALE PANEL 3 CRITICAL LOCK (Pose 7 + Pose 5):",
        panelAdultLock,
        "- LEFT Pose 7 is a LEGS-ONLY crop (waist to feet), NOT a full body, showing the same exact selected bottom (same color/fabric/details). HARD CROP LOCK: the head, face, chest, and upper torso MUST be entirely OUT of frame — the frame starts at the waistband and ends at the feet. Fill the frame with the lower body (waistband + closure, front rise, pockets, thighs, hem) and keep the shoes/feet visible at the very bottom. If a full standing body — or the head/torso — appears, it is WRONG and must be re-framed as a waist-to-feet crop.",
        "- RIGHT Pose 5 must be a close-up of the most detailed item from that same selected look.",
        closeUpSubjectLine,
        closeUpCategoryRule,
        "- Do not introduce a different person identity, different outfit, or different colorway in either side.",
      ];
    }
    return [
      "FEMALE PANEL 4 CRITICAL LOCK (Pose 6 + Pose 8):",
      panelAdultLock,
      "- LEFT Pose 6 must be relaxed full-body front with face visible.",
      "- RIGHT Pose 8 must be a single controlled creative shot from the same exact selected look.",
      footwearWhenFullBodyLine,
      "- Keep identity and outfit locked; no substitutions.",
    ];
  }
  if (panelNumber === 1) {
    return [
      "MALE PANEL 1 CRITICAL LOCK (Pose 1 + Pose 2):",
      panelAdultLock,
      "- LEFT Pose 1 must be full-body front neutral hero, straight-on camera.",
      "- RIGHT Pose 2 must be full-body lifestyle with subtle weight shift only.",
      "- Both frames must show full head and full feet in frame (no cropping).",
      footwearHardLockLine,
      "- Do not rotate LEFT frame into lifestyle angle. Do not replace RIGHT frame with torso crop.",
    ];
  }
  if (panelNumber === 2) {
    return [
      "MALE PANEL 2 CRITICAL LOCK (Pose 3 + Pose 4):",
      panelAdultLock,
      "- LEFT Pose 3 must be torso + head front crop (mid-thigh to head).",
      "- RIGHT Pose 4 must be full-body back view with full head and feet visible.",
      swimwearActive
        ? "- RIGHT Pose 4 swimwear footwear lock: use flip-flops/water-shoes, or naturally uncovered feet."
        : "- RIGHT Pose 4 footwear hard lock: shoes must be worn and visible. Barefoot is forbidden.",
      "- Same model identity, same selected look, no side swaps.",
    ];
  }
  if (panelNumber === 3) {
    return [
      "MALE PANEL 3 CRITICAL LOCK (Pose 5 + Pose 6):",
      panelAdultLock,
      "- LEFT Pose 5 is a LEGS-ONLY crop (waist to feet), NOT a full body. HARD CROP LOCK: the head, face, chest, and upper torso MUST be entirely OUT of frame — the frame starts at the waistband and ends at the feet. Fill the frame with the lower body (waistband, hips, thighs, knees, hem) and keep the shoes/feet visible at the very bottom. If a full standing body — or the head/torso — appears, it is WRONG and must be re-framed as a waist-to-feet crop.",
      "- RIGHT Pose 6 must be one close-up detail from the same selected item/look.",
      closeUpSubjectLine,
      closeUpCategoryRule,
      "- Do not replace close-up with full-body and do not change outfit.",
    ];
  }
  return [
    "MALE PANEL 4 CRITICAL LOCK (Pose 7 + Pose 8):",
    panelAdultLock,
    "- LEFT Pose 7 is a TORSO-BACK crop (mid-thigh to head), back-facing, with an over-the-shoulder head turn — NOT a full body. HARD CROP LOCK: crop the frame at mid-thigh; the lower legs and feet MUST be OUT of frame. If a full head-to-toe standing body appears, it is WRONG and must be re-framed as a mid-thigh-to-head crop.",
    "- LEFT Pose 7 back-surface lock: keep the back clean. Do not invent or add any back print/graphic/logo design.",
    "- Only show a back design if that exact design is clearly present in the locked item references.",
    "- RIGHT Pose 8 must be a single controlled creative pose from the same selected look.",
    "- Keep the same identity and item lock in both frames.",
  ];
}

export function extractPoseBlock(library: string, poseNumber: number) {
  const lib = String(library || "");
  const n = Number.isFinite(poseNumber) ? Math.trunc(poseNumber) : poseNumber;
  const patterns = [
    new RegExp(`(?:^|\\n\\s*)(POSE\\s+${n}\\s+[\\s\\S]*?)(?=\\n\\s*POSE\\s+\\d+\\s+|$)`, "i"),
    new RegExp(
      `(?:^|\\n\\s*)(FEMALE\\s*[-—]\\s*POSE\\s+${n}[\\s\\S]*?)(?=\\n\\s*POSE\\s+\\d+\\s+|\\n\\s*FEMALE\\s*[-—]\\s*POSE\\s+\\d+|$)`,
      "i"
    ),
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
  forceActivePoseOverride?: boolean;
  modelName: string;
  modelGender: string;
  modelRefs: string[];
  itemRefs: string[];
  itemType: string;
  itemStyleInstructions?: string;
  regenerationComments?: string;
  poseSafetySuggestions?: string[];
  /** Per-generation facial-expression cue (varies run-to-run so models don't look robotic). */
  expressionDirective?: string;
}) {
  const poseLibrary = getPoseLibraryForGender(args.modelGender);
  const fullPoseLibraries = [
    String(args.modelGender || "").toLowerCase() === "female"
      ? "FEMALE POSE LIBRARY (ORIGINAL, UNCHANGED):"
      : "MALE POSE LIBRARY (ORIGINAL, UNCHANGED):",
    poseLibrary,
  ].join("\n");
  const mappingText =
    String(args.modelGender || "").toLowerCase() === "female"
      ? FEMALE_PANEL_MAPPING_TEXT
      : MALE_PANEL_MAPPING_TEXT;
  const poseABlock = extractPoseBlock(poseLibrary, args.poseA);
  const poseBBlock = extractPoseBlock(poseLibrary, args.poseB);
  const criticalLockLines = getPanelCriticalLockLines(
    args.modelGender,
    args.panelNumberForLocks ?? args.panelNumber,
    args.itemType
  );
  const swimwearActive = isSwimwearItemType(args.itemType);
  const swimwearStyleLines = getSwimwearStyleLockLines(args.modelGender, args.itemType);
  const closeUpCategoryRule = getCloseUpCategoryRule(args.itemType);
  const promptItemType =
    String(args.modelGender || "").trim().toLowerCase() === "female" &&
    isSwimwearItemType(args.itemType)
      ? "swimwear"
      : args.itemType.trim();
  const closeUpSubjectLine = promptItemType
    ? `- CLOSE-UP SUBJECT LOCK: the close-up subject must match section 0.5 item type "${promptItemType}" exactly.`
    : "- CLOSE-UP SUBJECT LOCK: the close-up subject must match section 0.5 item type exactly.";
  const styleInstructions = normalizePromptInstruction(args.itemStyleInstructions);
  const regenNotes = normalizePromptInstruction(args.regenerationComments);
  const expressionDirective =
    normalizePromptInstruction(args.expressionDirective, 240) ||
    "a natural, relaxed premium expression with soft, warm eyes";

  return [
    "CHATGPT-ONLY EXECUTION HARD LOCK (embedded by app)",
    "ITEM REFERENCE INTERPRETATION HARD LOCK:",
    "- Treat every uploaded item image as product reference only.",
    "- Item images may show a person, flat-lay, hanger, or mannequin.",
    "- Do not block item images because a person is wearing the product. Keep the image and use garment details only.",
    "- Never copy any person identity/presentation from item refs (face, skin tone, hair, body type, pose, identity).",
    "- Never copy presentation style from item refs (model styling, camera angle, background composition, pose styling).",
    "- Human in item refs = temporary hanger/mannequin only. Not a character source.",
    "- Forbidden from item-ref humans: face shape, eyes, nose, lips, jawline, skin tone, hair texture/color/style/hairline, age cues, body proportions, tattoos, jewelry.",
    "- If any item ref conflicts with model identity, ignore the human and keep only garment details.",
    "- Identity source priority is absolute: MODEL refs first and only for person identity; item refs are garment-only.",
    `- LOCKED ITEM TYPE PRIORITY: section 0.5 item type is "${promptItemType || args.itemType || "apparel item"}".`,
    "- When full-look references are present, preserve the full outfit structure (top, bottom, shoes, accessories) across frames.",
    "- Use isolated item references only to refine the locked item details; do not restyle or replace non-target full-look pieces.",
    "- Use item refs only for product attributes: shape, color, material, construction, and details.",
    "- If a full-body outfit image is provided, treat it as a single full-look reference and preserve the whole look structure (top, bottom, shoes, accessories).",
    "- If full-look + separate item images are both provided, match each extra item to the corresponding part in the full look and replace only those matched parts.",
    "- Keep all non-replaced parts from the full-look reference unchanged.",
    "FULL-OUTFIT REPRODUCTION HARD LOCK (all genders, EVERY panel, EVERY frame):",
    "- If any item reference shows a complete outfit (worn on a person, on a mannequin, on a hanger, or flat-lay), reproduce that ENTIRE outfit exactly in every panel and every full-body frame: top, bottom, outerwear, EVERY visible accessory (belt, bag, hat/cap, jewelry, watch, sunglasses, scarf, socks) AND the exact shoes.",
    "- Do NOT drop, omit, simplify, swap, recolor, or restyle any piece of the outfit between panels, frames, or poses. The same complete look — same accessories, same exact shoes — must appear consistently across the entire run.",
    "- Accessories and shoes shown in the outfit reference are mandatory in all full-body frames; never remove them for a 'cleaner' shot.",
    "EXACT ITEM-DETAIL FIDELITY HARD LOCK (all genders — the product must be 100% identical and consistent across every panel, frame, and pose):",
    "- Reproduce every construction detail EXACTLY as shown in the references and keep it identical across the whole run: distressing/rips (exact rip placement, length, and fray), whiskering, washes/fades, seams, topstitching, pockets, rivets, zippers, buttons, hardware, collar/neckline, cuffs, and hems.",
    "- Preserve the exact FIT and silhouette shown: a tight/slim shirt stays tight; a relaxed or oversized cut stays that; skinny vs straight vs wide legs stay exactly as referenced. Never loosen, tighten, lengthen, shorten, or reshape the garment between frames.",
    "- Reproduce all logos, brand marks, text, prints, graphics, and patterns EXACTLY (same artwork, position, scale, and colors). Never invent, move, resize, mirror, recolor, or restyle them, and never add logos/prints that are not in the references.",
    "- Shoes must be the EXACT same pair (model, color, material, laces, sole) in every full-body frame; never swap or restyle footwear across panels.",
    "- The item color, material, weave, and texture must stay identical across the entire run under consistent lighting; no colorway or fabric drift between panels.",
    "NO-GUESS / NO-INVENTION HARD LOCK (all genders):",
    "- Never invent, add, or hallucinate garments, accessories, prints, logos, branding, patterns, hardware, or styling that are not clearly shown in the item references or explicitly requested in the styling instructions. When unsure, do not add it.",
    "- If only part of an outfit is provided (e.g. a single top), do NOT invent a designed or branded outfit around it. Any complementary basics needed to complete a clean full-body shot must be plain, neutral, solid-color, and unbranded, and must defer to the styling instructions whenever they are given.",
    "- Footwear is the ONLY mandatory addition and the ONLY exception to no-guess: every full-body frame must ALWAYS show shoes — never barefoot, never socks-only. Use the exact shoes from the references or styling instructions; if no shoes are provided or instructed, use clean neutral unbranded studio sneakers, the same pair across the whole run.",
    "- CLOSE-UP LOCK: for MALE Pose 6 and FEMALE Pose 5, generate one close-up using section 0.5 item references.",
    closeUpSubjectLine,
    closeUpCategoryRule,
    "- If a set or multiple items are present, choose the most detailed item that still matches the locked section 0.5 item type.",
    ...(styleInstructions
      ? [
          "ITEM STYLING INSTRUCTIONS (SECTION 0.5, APPLY WITH LOCKS):",
          "- Apply these fit/silhouette/style instructions while preserving exact product identity/details from item refs.",
          styleInstructions,
        ]
      : []),
    ...(regenNotes
      ? [
          "REGENERATION FEEDBACK (APPLY FOR THIS PASS):",
          "- Use these corrections to improve accuracy while preserving all hard locks above.",
          regenNotes,
        ]
      : []),
    "POSE SET SELECTION (HARD LOCK):",
    "- If MODEL.gender == male: use MALE POSE SET definitions unchanged.",
    "- If MODEL.gender == female: use FEMALE POSE SET definitions unchanged.",
    "- IMPORTANT: only panel-to-pose pairing changes by gender. Pose definitions stay unchanged.",
    "GENDER-SPECIFIC PANEL MAPPING (IMMUTABLE PER GENDER):",
    "PANEL MAPPING IS IMMUTABLE. DO NOT REMAP.",
    ...(args.forceActivePoseOverride
      ? [
          "FALLBACK OVERRIDE (THIS GENERATION ONLY): if mapping conflicts with the ACTIVE pose assignments below, ignore the mapping and execute the ACTIVE poses exactly as provided.",
        ]
      : []),
    mappingText,
    "PANEL OUTPUT HARD LOCK:",
    "- Generate exactly ONE panel image.",
    "- Each panel is a 2-up canvas only: LEFT Pose A, RIGHT Pose B.",
    "- Never output 3+ poses in one canvas. No collage. No grids.",
    "POSE LIBRARIES (ORIGINAL, UNCHANGED) INCLUDED BELOW FOR REFERENCE:",
    fullPoseLibraries,
    "Generate exactly ONE 2-up panel image.",
    "Age requirement: the model must be an adult 25+ only.",
    `PANEL ${args.panelNumber} HARD AGE LOCK: the model is over 25+.`,
    "Canvas 1536x1024; left frame 768x1024; right frame 768x1024; thin divider.",
    "No collage, no extra poses, no extra panels.",
    "Identity anchor override: use ONLY MODEL refs for face/body identity.",
    "Run-level identity lock: across all selected panels in this run, preserve the same exact model face identity.",
    "Identity consistency lock: keep the same exact person identity across every generated panel in this run (same face structure, eyes, nose, lips, skin tone, and hairline).",
    "Do not drift identity panel-to-panel.",
    "Hard identity lock: this must be the exact same person across all panels in this generation batch.",
    "Face-geometry lock: keep the same eye shape/spacing, nose bridge/tip, lip contour, jawline, cheek structure, and brow shape as model refs.",
    "Skin-tone lock: preserve the exact model skin tone and undertone from model refs. Never lighten, darken, recolor, or stylistically shift skin tone.",
    "Hair lock: keep the exact model hair COLOR, shade, tone, length, texture, and style from model refs identical across every panel; never recolor, lighten, darken, lengthen, shorten, or restyle the hair.",
    "Do not change age appearance, facial proportions, skin tone, hairline, or ethnicity between panels.",
    "HUMAN EXPRESSION VARIATION (all genders — avoid robotic sameness):",
    "- Keep the exact locked identity, but the face must look alive and human, never a frozen, mannequin-like, or repeated identical stare.",
    "- Give a natural, believable premium/editorial facial expression, and allow subtle natural variation between the two frames so they never look duplicated.",
    `- EXPRESSION FOR THIS GENERATION: ${expressionDirective}.`,
    "- Expression changes ONLY the mouth, eye warmth, brow, and gaze. It must NEVER alter face geometry, bone structure, identity, age, skin tone, or hairline — those stay fully identity-locked.",
    "Item refs are product-only anchors; never copy identity from item photos.",
    "If an item photo shows a real person, treat that person as invisible except for clothing pixels.",
    "Item-photo human = mannequin/hanger only for product display. Never transfer face, hair, skin, body, age, tattoos, or jewelry traits.",
    "Fail-closed lock: if exact locked model identity and exact locked item look cannot both be shown, do not output an image.",
    "Outfit continuity lock: both left and right frames must represent the same selected outfit/look from item references (unless right frame is an intentional close-up of that same look).",
    "No outfit swaps, no colorway swaps, no garment substitutions across frames.",
    "No styling reinterpretation lock: do not add styling changes that were not explicitly present in item references.",
    "GLOBAL BACK-DESIGN HARD LOCK (ALL GENDERS, ALL PANELS, ALL POSES):",
    "- For any back-facing frame, never invent, redesign, or hallucinate back graphics/logos/prints.",
    "- If item references include a clear back design, reproduce that exact back design only.",
    "- If item references do not include a clear back design, keep the back fully solid/clean in item color only.",
    "Photorealism hard lock: realistic human anatomy and skin texture. No CGI, no mannequin-like skin, no plastic look, no uncanny facial structure.",
    "PROFESSIONAL FASHION CATALOG LOCK:",
    "- Ecommerce fashion catalog for a clothing company; the model is an adult 25+.",
    "- Keep composition professional, neutral, and storefront-safe (no suggestive mood or posture, neutral camera angle).",
    ...(swimwearActive
      ? [
          "- This item is swimwear: use standard commercial swimwear coverage only (a regular bikini or one-piece for women; swim shorts/trunks for men), consistent with a mainstream retail catalog.",
        ]
      : [
          "- Keep the model fully and appropriately clothed in normal opaque garments; no bare-chest styling and no bottoms-only.",
        ]),
    ...(args.poseSafetySuggestions && args.poseSafetySuggestions.length
      ? [
          "POSE SAFETY MODIFICATIONS (from pre-generation scan — apply strictly):",
          ...args.poseSafetySuggestions,
        ]
      : []),
    `Panel request: Panel ${args.panelNumber} (${args.panelLabel}).`,
    `Active pose priority: LEFT Pose ${args.poseA}, RIGHT Pose ${args.poseB}.`,
    `LEFT ACTIVE POSE ${args.poseA} HARD AGE LOCK: the model is over 25+.`,
    `RIGHT ACTIVE POSE ${args.poseB} HARD AGE LOCK: the model is over 25+.`,
    "POSE PROMPTING METHOD HARD LOCK:",
    "- Only two active poses are allowed in this generation call.",
    "- LEFT frame must execute ACTIVE Pose A only.",
    "- RIGHT frame must execute ACTIVE Pose B only.",
    "Pose execution hard lock: LEFT frame must execute only LEFT active pose. RIGHT frame must execute only RIGHT active pose.",
    "ONLY these two active poses are allowed in this image.",
    ...criticalLockLines,
    ...swimwearStyleLines,
    `LEFT ACTIVE POSE:\n${poseABlock}`,
    `RIGHT ACTIVE POSE:\n${poseBBlock}`,
    "All non-active poses are reference only and must not execute in this image.",
    "Full-body framing lock (male + female): whenever an active pose is full-body, include full head and both feet entirely in frame. No cropping of head, hair, chin, toes, or shoes.",
    "Full-body no-crop applies to: Male poses 1,2,4 and Female poses 1,2,3,6.",
    "CROP-ONLY LOCK (these poses are NEVER a full standing body): Male Pose 5 = LEGS ONLY (waist to feet), Male Pose 3 = mid-thigh to head, Male Pose 7 = torso-back mid-thigh to head, Female Pose 7 = LEGS ONLY (waist to feet), Female Pose 4 = upper body, Female Pose 5 = close-up. For each of these, the out-of-frame body parts (head/torso for legs crops; lower legs/feet for torso crops) MUST be cropped OUT of the frame. Rendering a full head-to-toe standing body for any of these is WRONG.",
    "3:4 split centering hard lock: each panel half is center-cropped to a final 3:4 portrait. Keep each active pose centered in its own half.",
    "3:4 safe-zone math lock (for 1536x1024 panel output): each half is 768x1024 (already 3:4). Keep head/body/garment details inside this center-safe zone.",
    swimwearActive
      ? "Swimwear footwear lock (full-body): use clean flip-flops/sandals/water-shoes, or naturally uncovered feet."
      : "Footwear hard lock (full-body): for every full-body active pose, the model must wear visible shoes. Barefoot and socks-only are forbidden.",
    swimwearActive
      ? "If swimwear footwear is not defined in item refs, keep feet natural or use simple neutral flip-flops consistently across selected panels."
      : "If footwear is not clearly defined in item refs, use clean neutral studio sneakers and keep the same pair consistent across all selected panels in this run.",
    "No-crop mapping lock: in any panel where the active pose is full-body (male/female mapping), frame top-of-hair to bottom-of-shoes with visible white margin.",
    "Camera framing rule for full-body active poses: fit the complete body from top of hair to bottom of shoes with visible white margin above the head and below the feet.",
    "If a full-body active pose would crop head or feet, zoom out and reframe until full body is fully visible.",
    "If an active pose is not full-body (e.g., close-up/lower-body/torso crop), follow that crop as defined.",
    `Model: ${args.modelName} (${args.modelGender}).`,
    `Item type: ${promptItemType || args.itemType}.`,
    "Pure white background, high-key studio light, faint contact shadow only.",
    "Background hard lock: keep a sharp, clean studio white background (no gray cast, no gradient, no vignette, no texture, no wrinkles).",
    "Background hard lock: use seamless pure white cyclorama look (#FFFFFF), no horizon line, and no color tint.",
    "Cross-panel consistency lock: keep the same white background tone and lighting style across all selected panels in this run.",
    "Hands rule: no hands in pockets.",
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
