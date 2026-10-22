/**
 * Carbon Studio — accessory mode.
 *
 * Clothes are sold on a body in eight poses. Accessories are not: a bracelet is
 * bought from its hero shot, its detail, its clasp and its size on a wrist, and
 * a hat from how it sits on a head. So when the product is an accessory the
 * Studio swaps the garment pose library for an eight-shot list built for that
 * kind of item — four product-only shots and four on the stored model — and
 * dresses the model in an outfit chosen to show the item off.
 *
 *   Panel 1: Shot 1 hero          + Shot 2 second angle
 *   Panel 2: Shot 3 macro detail  + Shot 4 fastening
 *   Panel 3: Shot 5 worn, close   + Shot 6 lifestyle
 *   Panel 4: Shot 7 pairing       + Shot 8 editorial flat lay
 *
 * The kind of accessory comes from the Item type field, and for products filed
 * under ACCESSORIES from the product name ("Beaded Bracelet A", "Kai
 * Sunglasses"), because there the Item type field only says "ACCESSORIES".
 */

import { buildAbsentFeatureGuard } from "@/lib/panelGeneration";

export type AccessoryKind =
  | "wrist"
  | "ankle"
  | "neck"
  | "ring"
  | "ear"
  | "eyewear"
  | "hat"
  | "belt"
  | "bag"
  | "socks"
  | "bowtie"
  | "other";

export const ACCESSORY_KINDS: AccessoryKind[] = [
  "wrist",
  "ankle",
  "neck",
  "ring",
  "ear",
  "eyewear",
  "hat",
  "belt",
  "bag",
  "socks",
  "bowtie",
  "other",
];

/* Order matters: "anklet" before "bracelet"-style words, "earring" before
   "ring", "bow tie" before anything that could read "tie". */
const KIND_WORDS: [AccessoryKind, RegExp][] = [
  ["eyewear", /\b(sunglass(?:es)?|eyewear|eyeglasses|shades)\b/i],
  ["ankle", /\banklets?\b/i],
  ["ear", /\b(earrings?|ear\s?cuffs?|ear\s?climbers?)\b/i],
  ["wrist", /\b(bracelets?|bangles?|wristbands?|watch(?:es)?)\b/i],
  ["neck", /\b(necklaces?|pendants?|chokers?)\b/i],
  ["ring", /\brings?\b/i],
  ["bowtie", /\b(bow\s?ties?|neck\s?ties?)\b/i],
  ["hat", /\b(hats?|caps?|beanies?|snapbacks?|bucket\s?hats?|truckers?)\b/i],
  ["belt", /\bbelts?\b/i],
  ["bag", /\b(bags?|totes?|backpacks?|crossbody|clutch(?:es)?|purses?|wallets?)\b/i],
  ["socks", /\bsocks?\b/i],
];

/* Filed under ACCESSORIES in the catalogue but worn as clothing ("Men's Boxer
   Brief 3-Pack"): those keep the normal apparel flow. */
const NOT_ACCESSORY = /\b(boxers?|briefs?|underwear|trunks?|bras?|lingerie|panties)\b/i;
/* An item type that is plainly a garment never switches mode on a stray word
   ("CAP SLEEVE TOP", "TIE-DYE TEE", "BELTED DRESS"). */
const APPAREL = /\b(top|tee|t-shirt|shirt|blouse|tank|dress|skirt|jacket|coat|blazer|hoodie|sweater|pants?|trousers?|jeans?|shorts|leggings?|jumpsuit|romper|vest)\b/i;

function kindOf(text: string): AccessoryKind | null {
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind;
  return null;
}

/**
 * The accessory kind of this product, or null for clothing.
 *
 * `subcategory` is the catalogue's subcategory (the Studio's default item type),
 * `productName` the matrix description.
 */
export function getAccessoryKind(itemType: string, productName: string, subcategory: string): AccessoryKind | null {
  const type = String(itemType || "");
  const name = String(productName || "");
  if (NOT_ACCESSORY.test(`${type} ${name}`)) return null;
  const inAccessories = /accessor/i.test(subcategory || "") || /\b(accessor\w*|jewel\w*)\b/i.test(type);
  if (!inAccessories && APPAREL.test(type)) return null;
  const fromType = kindOf(type);
  if (fromType) return fromType;
  if (!inAccessories) return null;
  return kindOf(name) ?? "other";
}

/** The type word to show in the Item type field for a product filed as "ACCESSORIES". */
export function accessoryTypeWord(productName: string): string {
  const name = String(productName || "");
  for (const [, re] of KIND_WORDS) {
    const m = re.exec(name);
    if (m) return m[1] ? m[1].toUpperCase() : m[0].toUpperCase();
  }
  return "";
}

/** Panel n renders shots 2n-1 and 2n, whatever the model's gender. */
export function accessoryShotPair(panel: number): [number, number] {
  const p = Math.min(4, Math.max(1, Math.floor(panel) || 1));
  return [2 * p - 1, 2 * p];
}

export function accessoryPanelLabel(panel: number): string {
  const [a, b] = accessoryShotPair(panel);
  return `Panel ${panel} (Shot ${a} + ${b})`;
}

/** Short names for the shots, for labels and the plan line. */
export const ACCESSORY_SHOT_NAMES = [
  "",
  "hero",
  "second angle",
  "macro detail",
  "fastening",
  "worn, close",
  "lifestyle",
  "pairing",
  "flat lay",
];

type G = "male" | "female";

type KindSpec = {
  noun: string;
  /** How the product lies in the hero shot. */
  hero: string;
  /** What the second angle makes legible. */
  angle: string;
  macro: string;
  fastening: string;
  worn: (g: G) => string;
  lifestyle: (g: G) => string;
  pairing: (g: G) => string;
  /** The garment it is laid next to in the flat lay. */
  flatlayWith: (g: G, partner: string) => string;
  /** The outfit, as lines for the styling lock. */
  outfit: (g: G, partner: string) => string[];
  /** On-model shots in which the face is in frame. */
  faceShots: number[];
};

const sneakers =
  "- FOOTWEAR (only if feet are in frame): chunky white leather low-top sneakers with a plain white sole, no branding.";

const KINDS: Record<AccessoryKind, KindSpec> = {
  wrist: {
    noun: "bracelet",
    hero: "laid in a relaxed open loop, the front (charm, centre bead or watch face) towards the camera",
    angle: "how the chain or band, the beads or links and any charm or dial sit in depth",
    macro: "the beads, links, charm or dial — the details a buyer zooms in on",
    fastening: "the clasp, and the extender chain or strap holes if there are any",
    worn: () =>
      "ON THE WRIST — a close crop of the model's forearm and hand with the product on the wrist, hand relaxed and natural, so its true size against a real wrist is obvious. Face not in frame.",
    lifestyle: () =>
      "LIFESTYLE — the model from chin to hip in the styling outfit, the wrist with the product naturally in view (a hand in a pocket, at a sleeve, at the collar). Face cropped at the chin.",
    pairing: (g) =>
      g === "female"
        ? "PAIRING — the wrist stacked with ONE thin plain gold or silver chain bracelet next to the product, which stays in front and in focus. Forearm and hand crop, no face."
        : "PAIRING — the wrist with ONE plain watch on a black leather strap next to the product, which stays in front and in focus. Forearm and hand crop, no face.",
    flatlayWith: (_g, partner) => `a neatly folded plain ${partner} heavyweight tee`,
    outfit: (g, partner) => [
      g === "female"
        ? `- TOP: a fitted short-sleeve or sleeveless top in ${partner}, so the wrist and forearm are completely bare.`
        : `- TOP: a heavyweight short-sleeve tee in ${partner}, sleeves well clear of the wrist.`,
      g === "female"
        ? "- BOTTOM: high-waisted wide-leg mid-blue washed denim jeans."
        : "- BOTTOM: relaxed straight-leg mid-blue washed denim jeans.",
      "- JEWELLERY: nothing else on the wrists or hands, except the one piece in the pairing shot.",
    ],
    faceShots: [],
  },
  ankle: {
    noun: "anklet",
    hero: "laid in a relaxed open loop, any charm towards the camera",
    angle: "how the chain, beads and charm sit in depth",
    macro: "the chain links, beads and any charm",
    fastening: "the clasp and the extender chain",
    worn: () =>
      "ON THE ANKLE — a close crop of the model's lower leg and foot with the anklet on the ankle, foot relaxed, so its true size against a real ankle is obvious.",
    lifestyle: () =>
      "LIFESTYLE — from the knee down, the model walking or standing with one foot slightly forward, the anklet catching the light.",
    pairing: () =>
      "PAIRING — the same ankle with ONE second thin plain chain anklet layered next to the product, which stays in front and in focus. Lower-leg crop.",
    flatlayWith: () => "a pair of folded cropped jeans",
    outfit: (_g, partner) => [
      `- BOTTOM: cropped wide-leg jeans or trousers in ${partner} ending above the ankle, so the ankle is bare.`,
      "- FOOTWEAR: minimal flat sandals with thin straps, or bare feet — nothing covering the ankle.",
      "- JEWELLERY: nothing else on the ankles, except the one piece in the pairing shot.",
    ],
    faceShots: [],
  },
  neck: {
    noun: "necklace",
    hero: "laid in a soft curve with the pendant or centre at the bottom middle",
    angle: "how the chain and the pendant hang and sit in depth",
    macro: "the pendant and the chain links",
    fastening: "the clasp and any extender chain",
    worn: () =>
      "ON THE NECK — a close crop of the neck and collarbone with the necklace lying naturally, chin at the top edge of the frame.",
    lifestyle: () =>
      "LIFESTYLE — a shoulders-up portrait of the model in the styling outfit, the necklace clearly visible at the neckline. Face visible, relaxed and natural.",
    pairing: () =>
      "PAIRING — layered with ONE shorter plain fine chain above it; the product stays the clear focus. Neck and collarbone crop, no face above the lips.",
    flatlayWith: (_g, partner) => `a neatly folded plain ${partner} tee`,
    outfit: (g, partner) => [
      g === "female"
        ? `- TOP: an open scoop-neck or square-neck top in ${partner} — the collarbone and the whole necklace uncovered.`
        : `- TOP: a crew-neck tee or an open-collar shirt in ${partner}, the necklace worn over it and fully visible.`,
      "- HAIR: away from the neck, never covering the chain.",
      "- JEWELLERY: nothing else at the neck, except the one piece in the pairing shot.",
    ],
    faceShots: [6],
  },
  ring: {
    noun: "ring",
    hero: "standing upright, the top, stone or engraving towards the camera",
    angle: "the profile of the band and how the top sits above it",
    macro: "the top of the ring — stone, setting or engraving",
    fastening: "the inside of the band and its profile thickness",
    worn: () =>
      "ON THE HAND — a close crop of the model's hand with the ring on the finger, fingers relaxed, so its true size against a real finger is obvious.",
    lifestyle: () =>
      "LIFESTYLE — the model's hand resting at the jaw, in a pocket or holding a coffee cup, in the styling outfit, the ring in clear view. Face cropped at the chin.",
    pairing: () =>
      "PAIRING — the same hand stacked with one or two plain thin bands on the neighbouring fingers; the product stays the clear focus. Hand crop.",
    flatlayWith: () => "a small fold of plain linen and a plain ceramic ring dish",
    outfit: (_g, partner) => [
      `- TOP: a plain long-sleeve or short-sleeve top in ${partner}, sleeves clear of the hands.`,
      "- HANDS: clean, natural nails; nothing else on the fingers, except the pieces in the pairing shot.",
    ],
    faceShots: [],
  },
  ear: {
    noun: "earrings",
    hero: "the pair side by side, fronts towards the camera",
    angle: "the depth and the drop of each earring",
    macro: "the front of one earring — stone, finish, shape",
    fastening: "the back: post and butterfly, hook, or hoop catch",
    worn: () => "ON THE EAR — a side-profile close crop of the ear and jaw with the earring worn.",
    lifestyle: () =>
      "LIFESTYLE — a three-quarter head-and-shoulders portrait in the styling outfit, the earring clearly visible. Face visible, relaxed and natural.",
    pairing: () =>
      "PAIRING — worn with ONE matching fine plain necklace; the earring stays the clear focus. Head-and-shoulders, three-quarter.",
    flatlayWith: () => "a small plain jewellery tray on linen",
    outfit: (g, partner) => [
      `- TOP: an open-neck top in ${partner}.`,
      g === "female" ? "- HAIR: tucked behind the ear or tied back, so the ear is fully visible." : "- HAIR: short, clear of the ear.",
      "- JEWELLERY: nothing else, except the one piece in the pairing shot.",
    ],
    faceShots: [6, 7],
  },
  eyewear: {
    noun: "sunglasses",
    hero: "front view, arms open, lenses towards the camera",
    angle: "a three-quarter view showing the frame depth and the arms",
    macro: "one lens and the front frame corner with any logo",
    fastening: "the hinge and the temple arm with its tip",
    worn: () =>
      "WORN, FRONT — a head-and-shoulders portrait with the sunglasses on, looking straight at the camera. Face visible.",
    lifestyle: () =>
      "LIFESTYLE — a street-style three-quarter portrait from the chest up, head slightly turned, in the styling outfit. Face visible.",
    pairing: () =>
      "PAIRING — worn with ONE plain fine chain necklace; the sunglasses stay the clear focus. Chest-up.",
    flatlayWith: () => "a folded pair of denim jeans",
    outfit: (_g, partner) => [
      `- TOP: a boxy heavyweight tee or an open overshirt in ${partner}.`,
      "- FACE: nothing else on the face; no hat.",
      "- JEWELLERY: none, except the one piece in the pairing shot.",
    ],
    faceShots: [5, 6, 7],
  },
  hat: {
    noun: "hat",
    hero: "a three-quarter front view, sitting naturally, front logo towards the camera",
    angle: "the side profile, showing the crown height and the brim",
    macro: "the front logo or embroidery and its stitching",
    fastening: "the back strap or adjuster, and the inside band",
    worn: () => "WORN, FRONT — a head-and-shoulders portrait with the hat on, the front fully visible. Face visible.",
    lifestyle: () =>
      "WORN, SIDE AND BACK — a three-quarter view from behind, showing the back of the hat and its adjuster as worn.",
    pairing: () =>
      "PAIRING — worn with plain black sunglasses; the hat stays the clear focus. Head-and-shoulders. Face visible.",
    flatlayWith: (_g, partner) => `a neatly folded plain ${partner} hoodie`,
    outfit: (_g, partner) => [
      `- TOP: a plain heavyweight hoodie or a boxy tee in ${partner}, matched to the hat's streetwear style.`,
      "- HAIR: styled to sit naturally under the hat, never pushing it out of shape.",
      "- ACCESSORIES: none, except the sunglasses in the pairing shot.",
    ],
    faceShots: [5, 7],
  },
  belt: {
    noun: "belt",
    hero: "loosely coiled with the buckle on top, facing the camera",
    angle: "the buckle in profile and the strap thickness",
    macro: "the buckle face and its finish",
    fastening: "the holes, the keeper loop and the strap edge",
    worn: () =>
      "ON THE WAIST — a close crop of the waist from the front, buckle centred, top tucked in, the belt through every loop.",
    lifestyle: () =>
      "LIFESTYLE — the full look from shoulders to shoes in the styling outfit, the belt clearly visible at the waist. Face cropped at the chin.",
    pairing: () =>
      "PAIRING — the belt worn with a tucked shirt and a plain watch, from chest to mid-thigh; the belt stays the clear focus.",
    flatlayWith: () => "a pair of folded denim jeans",
    outfit: (g, partner) => [
      `- TOP: a plain top in ${partner}, fully tucked in so the whole waistline shows.`,
      g === "female"
        ? "- BOTTOM: high-waisted straight-leg jeans or trousers with belt loops."
        : "- BOTTOM: straight-leg jeans or trousers with belt loops.",
      sneakers,
      "- ACCESSORIES: none, except the watch in the pairing shot.",
    ],
    faceShots: [],
  },
  bag: {
    noun: "bag",
    hero: "standing upright, front towards the camera, strap arranged neatly",
    angle: "a three-quarter view showing the depth and the side panel",
    macro: "the hardware and any logo",
    fastening: "the opening, its closure and a glimpse of the interior",
    worn: () => "CARRIED — the bag held in one hand at the side, from chest to knee.",
    lifestyle: () =>
      "LIFESTYLE — the bag on the shoulder, full look from shoulders to shoes in the styling outfit. Face cropped at the chin.",
    pairing: () => "PAIRING — the bag with a matching plain belt, from chest to knee; the bag stays the clear focus.",
    flatlayWith: (_g, partner) => `a folded plain ${partner} tee and folded jeans`,
    outfit: (_g, partner) => [
      `- OUTFIT: a plain top in ${partner} and straight-leg jeans — simple, so the bag leads.`,
      "- The strap side of the body stays clear of hair and jackets.",
      sneakers,
    ],
    faceShots: [],
  },
  socks: {
    noun: "socks",
    hero: "the pair laid flat side by side, slightly overlapping",
    angle: "a three-quarter view showing the cuff height and the knit",
    macro: "the knit texture and any pattern or logo",
    fastening: "the cuff, and the heel and toe construction",
    worn: () => "ON THE FOOT — the feet and ankles in white low-top sneakers, the sock cuff fully visible.",
    lifestyle: () => "LIFESTYLE — from the knee down, seated or walking, the socks and sneakers in view.",
    pairing: () => "PAIRING — the socks worn with white slides instead of sneakers, knee down.",
    flatlayWith: () => "a pair of white sneakers",
    outfit: (_g, partner) => [
      `- BOTTOM: cropped trousers or shorts in ${partner} ending above the ankle, so the whole sock cuff shows.`,
      "- FOOTWEAR: clean white low-top sneakers (white slides in the pairing shot).",
    ],
    faceShots: [],
  },
  bowtie: {
    noun: "bow tie",
    hero: "flat, front towards the camera, centred",
    angle: "a three-quarter view showing the knot volume",
    macro: "the fabric, knot and texture",
    fastening: "the neck strap and the adjuster at the back",
    worn: () => "WORN — a close crop of the shirt collar with the bow tie centred.",
    lifestyle: () => "LIFESTYLE — a chest-up portrait in the styling outfit, the bow tie centred. Face visible.",
    pairing: () => "PAIRING — with a matching plain pocket square in the blazer pocket, chest-up.",
    flatlayWith: () => "a folded crisp white dress shirt",
    outfit: () => [
      "- TOP: a crisp white dress shirt, collar buttoned, under a dark tailored blazer.",
      "- ACCESSORIES: none, except the pocket square in the pairing shot.",
    ],
    faceShots: [6, 7],
  },
  other: {
    noun: "accessory",
    hero: "centred, front towards the camera, sitting naturally",
    angle: "a three-quarter view showing its depth and shape",
    macro: "its most distinctive detail",
    fastening: "how it closes or attaches",
    worn: () => "WORN OR HELD — a close crop on the model showing its true size.",
    lifestyle: () => "LIFESTYLE — the model in the styling outfit with the accessory clearly in view. Face cropped at the chin.",
    pairing: () => "PAIRING — with ONE simple complementary piece; the product stays the clear focus.",
    flatlayWith: (_g, partner) => `a neatly folded plain ${partner} tee`,
    outfit: (_g, partner) => [`- OUTFIT: a clean streetwear outfit in ${partner} that leaves the product fully visible.`, sneakers],
    faceShots: [],
  },
};

function isLight(colour: string): boolean {
  return /\b(white|off.?white|cream|ivory|ecru|beige|sand|stone|bone|light|pale|pastel|pink|yellow|gold|silver|clear|mint|lavender)\b/i.test(
    colour || "",
  );
}

/** The partner colour for clothes worn with the product: dark for light pieces and metals, light otherwise. */
function partnerColour(itemColour: string): string {
  return isLight(itemColour) ? "black" : "off-white";
}

function pickBySeed<T>(seed: number, salt: number, options: T[]): T {
  return options[Math.abs(Math.floor(seed) + salt) % options.length];
}

/** The metal of a pairing piece: the product's own when its colour names one. */
function pairingMetal(itemColour: string, seed: number): "gold" | "silver" {
  if (/\b(silver|platinum|steel|chrome)\b/i.test(itemColour || "")) return "silver";
  if (/\bgold\b/i.test(itemColour || "")) return "gold";
  return pickBySeed(seed, 11, ["gold", "silver"] as const);
}

/*
 * The on-model shots of the shot list, with every "X or Y" decided from the
 * look seed (lib/studioLookSheet.ts). The four panels are four separate
 * renders; a choice left in the words ("walking or standing", "one or two
 * bands") is made again by each of them.
 */
const RESOLVED_ON_MODEL: Partial<
  Record<
    AccessoryKind,
    {
      worn?: () => string;
      lifestyle?: (g: G, seed: number) => string;
      pairing?: (g: G, seed: number, metal: "gold" | "silver") => string;
    }
  >
> = {
  socks: {
    lifestyle: (_g, seed) =>
      `LIFESTYLE — from the knee down, the model ${pickBySeed(seed, 29, ["seated on a low white cube, feet flat", "caught mid-step"])}, the socks and sneakers in view.`,
  },
  other: {
    worn: () => "ON THE MODEL — a close crop of the product in use on the model, the way it is meant to be used, showing its true size.",
  },
  wrist: {
    lifestyle: (_g, seed) =>
      `LIFESTYLE — the model from chin to hip in the styling outfit, the wrist with the product naturally in view, ${pickBySeed(seed, 13, [
        "the hand resting at the collar",
        "the hand lightly at the opposite sleeve",
        "the hand resting at the hem of the top",
      ])}. Face cropped at the chin.`,
    pairing: (g, _seed, metal) =>
      g === "female"
        ? `PAIRING — the wrist stacked with ONE thin plain ${metal} chain bracelet next to the product, which stays in front and in focus. Forearm and hand crop, no face.`
        : "PAIRING — the wrist with ONE plain watch on a black leather strap next to the product, which stays in front and in focus. Forearm and hand crop, no face.",
  },
  ankle: {
    lifestyle: (_g, seed) =>
      `LIFESTYLE — from the knee down, the model ${pickBySeed(seed, 17, [
        "standing with one foot slightly forward",
        "caught mid-step, one foot slightly forward",
      ])}, the anklet catching the light.`,
    pairing: (_g, _seed, metal) =>
      `PAIRING — the same ankle with ONE second thin plain ${metal} chain anklet layered next to the product, which stays in front and in focus. Lower-leg crop.`,
  },
  ring: {
    lifestyle: (_g, seed) =>
      `LIFESTYLE — the model's hand ${pickBySeed(seed, 19, [
        "resting at the jaw",
        "holding a plain white coffee cup",
        "resting on the collarbone",
      ])}, in the styling outfit, the ring in clear view. Face cropped at the chin.`,
    pairing: (_g, seed, metal) =>
      pickBySeed(seed, 23, [
        `PAIRING — the same hand stacked with ONE plain thin ${metal} band on the neighbouring finger; the product stays the clear focus. Hand crop.`,
        `PAIRING — the same hand stacked with TWO plain thin ${metal} bands, one on each neighbouring finger; the product stays the clear focus. Hand crop.`,
      ]),
  },
  belt: {
    pairing: () =>
      "PAIRING — the belt worn with the same tucked-in top plus ONE plain watch on a black leather strap, from chest to mid-thigh; the belt stays the clear focus.",
  },
};

/**
 * What the model wears in the on-model shots of this kind, with every choice
 * made. `seed` is the look seed; `itemColour` picks the partner colour.
 * Returned in sheet order, keyed by slot so a photographed or chosen piece for
 * the same slot can replace the default.
 */
export function accessoryLookSlots(
  kind: AccessoryKind,
  gender: string,
  itemColour: string,
  seed: number,
): Array<{ slot: string; label: string; text: string }> {
  const g: G = String(gender || "").toLowerCase() === "female" ? "female" : "male";
  const p = partnerColour(itemColour);
  const plain = "plain — no print, no text, no logo";
  const sneakersLine = {
    slot: "footwear",
    label: "FOOTWEAR",
    text: "chunky white leather low-top sneakers with a plain white rubber sole and white laces, no branding (seen only in frames that show the feet)",
  };
  const jeans = (fit: string) => `${fit} mid-blue washed denim jeans, full length`;
  const only = (where: string) =>
    `nothing else ${where} and no other jewellery — the one extra piece is the one the PAIRING shot names`;
  switch (kind) {
    case "wrist":
      return [
        {
          slot: "top",
          label: "TOP",
          text:
            g === "female"
              ? `a fitted ${pickBySeed(seed, 1, ["short-sleeve", "sleeveless"])} crew-neck top in ${p}, ${plain}, so the wrist and forearm are completely bare`
              : `a heavyweight short-sleeve crew-neck tee in ${p}, ${plain}, sleeves well clear of the wrist`,
        },
        { slot: "bottom", label: "BOTTOM", text: jeans(g === "female" ? "high-waisted wide-leg" : "relaxed straight-leg") },
        { slot: "accessories", label: "ACCESSORIES", text: only("on the wrists and hands") },
      ];
    case "ankle":
      return [
        {
          slot: "bottom",
          label: "BOTTOM",
          text: `cropped wide-leg ${pickBySeed(seed, 2, ["jeans", "trousers"])} in ${p} ending above the ankle, so the ankle is bare`,
        },
        {
          slot: "footwear",
          label: "FOOTWEAR",
          text: pickBySeed(seed, 3, [
            `minimal flat sandals with thin ${p} straps — nothing covering the ankle, the same pair in every shot`,
            "none — bare feet in every shot, nothing covering the ankle",
          ]),
        },
        { slot: "accessories", label: "ACCESSORIES", text: only("on the ankles and feet") },
      ];
    case "neck":
      return [
        {
          slot: "top",
          label: "TOP",
          text:
            g === "female"
              ? `an open ${pickBySeed(seed, 4, ["scoop-neck", "square-neck"])} top in ${p}, ${plain} — the collarbone and the whole necklace uncovered`
              : pickBySeed(seed, 4, [
                  `a crew-neck tee in ${p}, ${plain}, the necklace worn over it and fully visible`,
                  `an open-collar shirt in ${p}, top button undone, ${plain}, the necklace worn over it and fully visible`,
                ]),
        },
        { slot: "hair", label: "HAIR", text: "away from the neck, never covering the chain" },
        { slot: "accessories", label: "ACCESSORIES", text: only("at the neck") },
      ];
    case "ring":
      return [
        {
          slot: "top",
          label: "TOP",
          text: `a ${pickBySeed(seed, 5, ["long-sleeve", "short-sleeve"])} crew-neck top in ${p}, ${plain}, sleeves clear of the hands`,
        },
        { slot: "hands", label: "HANDS", text: "clean, natural nails" },
        { slot: "accessories", label: "ACCESSORIES", text: only("on the fingers") },
      ];
    case "ear":
      return [
        {
          slot: "top",
          label: "TOP",
          text:
            g === "female"
              ? `an open ${pickBySeed(seed, 6, ["scoop-neck", "square-neck"])} top in ${p}, ${plain}`
              : `an open-collar shirt in ${p}, top button undone, ${plain}`,
        },
        {
          slot: "hair",
          label: "HAIR",
          text:
            g === "female"
              ? pickBySeed(seed, 7, ["tucked behind the ear, so the ear is fully visible", "tied back, so the ear is fully visible"])
              : "short, clear of the ear",
        },
        { slot: "accessories", label: "ACCESSORIES", text: only("anywhere") },
      ];
    case "eyewear":
      return [
        {
          slot: "top",
          label: "TOP",
          text: pickBySeed(seed, 8, [
            `a boxy heavyweight short-sleeve crew-neck tee in ${p}, ${plain}`,
            `an open overshirt in ${p} over a plain white crew-neck tee, ${plain}`,
          ]),
        },
        { slot: "face", label: "FACE", text: "nothing else on the face, no hat" },
        { slot: "accessories", label: "ACCESSORIES", text: only("anywhere") },
      ];
    case "hat":
      return [
        {
          slot: "top",
          label: "TOP",
          text: pickBySeed(seed, 9, [
            `a plain heavyweight pullover hoodie in ${p}, ${plain}`,
            `a boxy heavyweight short-sleeve crew-neck tee in ${p}, ${plain}`,
          ]),
        },
        { slot: "hair", label: "HAIR", text: "styled to sit naturally under the hat, never pushing it out of shape" },
        { slot: "accessories", label: "ACCESSORIES", text: "none — the only extra piece is the sunglasses the PAIRING shot names" },
      ];
    case "belt":
      return [
        { slot: "top", label: "TOP", text: `a fitted crew-neck t-shirt in ${p}, short sleeves, ${plain}, fully tucked in so the whole waistline shows` },
        {
          slot: "bottom",
          label: "BOTTOM",
          text: pickBySeed(seed, 10, [
            `${g === "female" ? "high-waisted " : ""}straight-leg mid-blue washed denim jeans with belt loops, full length`,
            `${g === "female" ? "high-waisted " : ""}straight-leg charcoal tailored trousers with belt loops, full length`,
          ]),
        },
        sneakersLine,
        { slot: "accessories", label: "ACCESSORIES", text: "none — the only extra piece is the watch the PAIRING shot names" },
      ];
    case "bag":
      return [
        { slot: "top", label: "TOP", text: `a crew-neck t-shirt in ${p}, short sleeves, ${plain} — simple, so the bag leads` },
        { slot: "bottom", label: "BOTTOM", text: jeans("straight-leg") },
        sneakersLine,
        { slot: "strap", label: "STRAP SIDE", text: "the strap side of the body stays clear of hair and jackets" },
        { slot: "accessories", label: "ACCESSORIES", text: "none — the only extra piece is the belt the PAIRING shot names" },
      ];
    case "socks":
      return [
        {
          slot: "bottom",
          label: "BOTTOM",
          text: pickBySeed(seed, 12, [
            `cropped straight trousers in ${p} ending above the ankle, so the whole sock cuff shows`,
            `knee-length shorts in ${p}, so the whole sock cuff shows`,
          ]),
        },
        {
          slot: "footwear",
          label: "FOOTWEAR",
          text: "clean white leather low-top sneakers with white soles and white laces; the PAIRING shot swaps them for plain white slides",
        },
      ];
    case "bowtie":
      return [
        { slot: "top", label: "TOP", text: "a crisp white dress shirt, collar buttoned, under a charcoal tailored blazer" },
        { slot: "accessories", label: "ACCESSORIES", text: "none — the only extra piece is the pocket square the PAIRING shot names" },
      ];
    default:
      return [
        { slot: "top", label: "TOP", text: `an oversized boxy heavyweight short-sleeve crew-neck t-shirt in ${p}, ${plain}` },
        { slot: "bottom", label: "BOTTOM", text: jeans("relaxed straight-leg") },
        sneakersLine,
        { slot: "accessories", label: "ACCESSORIES", text: only("anywhere") },
      ];
  }
}

/** The text of one shot, as it goes into the prompt. With `seed` (the look seed) the
 *  on-model shots carry no "X or Y" for the generator to settle on its own. */
export function accessoryShotText(kind: AccessoryKind, shot: number, gender: string, itemColour: string, seed?: number): string {
  const k = KINDS[kind] ?? KINDS.other;
  const g: G = String(gender || "").toLowerCase() === "female" ? "female" : "male";
  const partner = partnerColour(itemColour);
  const productOnly = "No person, no hands, no mannequin, no props. Seamless pure white background, soft even light, a faint contact shadow.";
  const resolved = Number.isFinite(seed) ? RESOLVED_ON_MODEL[kind] : undefined;
  const s = Math.floor(Number(seed));
  if (resolved?.worn && shot === 5) return `${resolved.worn()} Seamless pure white background.`;
  if (resolved?.lifestyle && shot === 6) return `${resolved.lifestyle(g, s)} Seamless pure white background.`;
  if (resolved?.pairing && shot === 7) return `${resolved.pairing(g, s, pairingMetal(itemColour, s))} Seamless pure white background.`;
  switch (shot) {
    case 1:
      return `HERO — the ${k.noun} alone, ${k.hero}, centred and large: it fills about two thirds of the frame. ${productOnly}`;
    case 2:
      return `SECOND ANGLE — the same ${k.noun} from a lower three-quarter angle, so ${k.angle} is easy to understand. ${productOnly}`;
    case 3:
      return `MACRO DETAIL — a tight close-up of ${k.macro}, filling the frame, pin-sharp, shallow depth of field. ${productOnly}`;
    case 4:
      return `FASTENING — a close-up of ${k.fastening}, clear enough to understand how it works. ${productOnly}`;
    case 5:
      return `${k.worn(g)} Seamless pure white background.`;
    case 6:
      return `${k.lifestyle(g)} Seamless pure white background.`;
    case 7:
      return `${k.pairing(g)} Seamless pure white background.`;
    case 8:
      return `EDITORIAL FLAT LAY — shot straight down from above: the ${k.noun} arranged on a light neutral linen surface next to ${k.flatlayWith(
        g,
        partner,
      )}, no logos, no text, nothing else. Soft daylight. No person.`;
    default:
      return `The ${k.noun}, centred on white.`;
  }
}

/** Shots with a person in frame. */
export function isOnModelShot(shot: number): boolean {
  return shot >= 5 && shot <= 7;
}

export function accessoryShowsFace(kind: AccessoryKind, shot: number): boolean {
  return (KINDS[kind] ?? KINDS.other).faceShots.includes(shot);
}

/**
 * What the model wears in the on-model shots. Named piece by piece, for the
 * same reason as the garment styling lock: four panels are four separate
 * generations, and only named pieces come back the same in each. A piece the
 * item photos show (the analyser's OUTFIT lines) replaces the default.
 */
export function buildAccessoryStylingLock(
  kind: AccessoryKind,
  gender: string,
  itemColour: string,
  seenOutfit?: Partial<Record<string, string>>,
  /** Pieces read off the operator's STYLE-WITH photos — they win over the photos' outfit and the defaults. */
  styleWith?: Partial<Record<string, string>>,
): string {
  const k = KINDS[kind] ?? KINDS.other;
  const g: G = String(gender || "").toLowerCase() === "female" ? "female" : "male";
  const label = (slot: string) => slot.toUpperCase().replace("_", " ");
  const chosen = Object.entries(styleWith ?? {})
    .filter(([, v]) => v)
    .map(([slot, v]) => `- ${label(slot)}: ${v} — the exact piece in the STYLE-WITH photos, worn in every on-model shot: same colour, cut, fit, fabric, print and hardware, each logo or text only where the photos show it; anything the photos do not show stays plain.`);
  const fromPhotos = Object.entries(seenOutfit ?? {})
    .filter(([slot, v]) => v && !styleWith?.[slot])
    .map(([slot, v]) => `- ${label(slot)}: ${v} — exactly as worn in the item photos.`);
  /* A default for a part of the body a photographed piece already covers would
     name two tops; the photographed one is what the operator wants. */
  const covered = new Set([...Object.keys(styleWith ?? {}), ...Object.keys(seenOutfit ?? {})].map(label));
  const lines = k.outfit(g, partnerColour(itemColour)).filter((l) => {
    const m = /^- ([A-Z ]+?)(?: \(|:)/.exec(l);
    return !(m && covered.has(m[1]));
  });
  return [...chosen, ...fromPhotos, ...lines].join("\n");
}

/**
 * The client half of an accessory panel prompt. The server appends its lock
 * block (identity, background, the verified spec, the colourway, the operator's
 * final word) exactly as it does for clothing.
 */
export function buildAccessoryPanelPrompt(args: {
  kind: AccessoryKind;
  panelNumber: number;
  modelName: string;
  modelGender: string;
  itemType: string;
  itemColour: string;
  itemStyleInstructions?: string;
  expressionDirective?: string;
  stylingLock: string;
  /** The operator attached STYLE-WITH photos (the server numbers them). */
  hasStyleWith?: boolean;
  /** The run's LOOK SHEET travels in the request body and sits in the server block (see
   *  lib/studioLookSheet.ts): this prompt then names no outfit of its own. `stylingLock`
   *  is ignored. */
  lookSheetInServer?: boolean;
  /** The look sheet's seed (LookSheet.seed): settles the "X or Y" in the on-model shots. */
  lookSeed?: number;
}): string {
  const [a, b] = accessoryShotPair(args.panelNumber);
  const k = KINDS[args.kind] ?? KINDS.other;
  const label = args.itemType || k.noun;
  const anyModel = isOnModelShot(a) || isOnModelShot(b);
  const anyFace = accessoryShowsFace(args.kind, a) || accessoryShowsFace(args.kind, b);
  const instruction = String(args.itemStyleInstructions || "").replace(/\s+/g, " ").trim();
  const lookSheet = args.lookSheetInServer === true;
  const outfitRef = lookSheet ? "the LOOK SHEET" : "the styling lock";
  return [
    `Professional ecommerce catalog photo shoot for an ACCESSORY: ${label}. Panel ${args.panelNumber} (Shot ${a} + Shot ${b}).`,
    "LAYOUT: output exactly one 3200x2000 image — the LEFT half (1600x2000) is the first shot, the RIGHT half (1600x2000) is the second shot, with a thin divider between them and nothing else: no third view, no collage, no grid, no text overlay.",
    `THE PRODUCT: the ${k.noun} in the item photos is what this shoot sells. Reproduce it exactly in every shot — every bead, link, charm, stone, logo, stitch and piece of hardware, the same count, colour, metal tone, finish and proportions. Keep its REAL size: never enlarge it into a costume piece or shrink it, and on the model it sits exactly as such a piece really sits.`,
    `ITEM REFERENCES: the item photos are product references only. Any person, hand or mannequin in them${args.hasStyleWith ? " or in a STYLE-WITH photo" : ""} is a display fixture — never copy a face, skin, body or pose from it.${args.hasStyleWith ? ` The pieces in the STYLE-WITH photos are worn by the model in every on-model shot, exactly as photographed (see ${outfitRef}).` : " Never copy styling from an item photo."}`,
    buildAbsentFeatureGuard(args.itemType),
    ...(anyModel
      ? [
          `THE MODEL: in the shots that show a person, it is ${args.modelName} (${args.modelGender}) from the MODEL references — same skin tone, hands and build${
            anyFace ? ", same face and hair" : ""
          }. Shots that are product-only have no person and no hands in them at all.`,
          ...(lookSheet
            ? [
                "OUTFIT: in every on-model shot of this run the model wears exactly the LOOK SHEET given with this prompt. Nothing else is worn; nothing on it is left out.",
              ]
            : [
                "STYLING LOCK — what the model wears in the on-model shots. Use these exact pieces in every on-model shot of this run:",
                args.stylingLock,
              ]),
        ]
      : []),
    ...(anyFace && args.expressionDirective
      ? [`EXPRESSION: ${args.expressionDirective}. The face looks alive and human; expression changes only the mouth, eyes and brow, never the face itself.`]
      : []),
    ...(instruction
      ? [
          "OPERATOR INSTRUCTION — written by the person publishing these photos, and the highest authority in this prompt. Where it disagrees with anything here, it wins. It is repeated as the last line of this prompt:",
          instruction,
        ]
      : []),
    "Photorealistic product photography: real materials, real reflections on metal and stone, real skin texture where a person appears; no CGI look.",
    `LEFT SHOT (Shot ${a}): ${accessoryShotText(args.kind, a, args.modelGender, args.itemColour, lookSheet ? args.lookSeed : undefined)}`,
    `RIGHT SHOT (Shot ${b}): ${accessoryShotText(args.kind, b, args.modelGender, args.itemColour, lookSheet ? args.lookSeed : undefined)}`,
  ].join("\n");
}
