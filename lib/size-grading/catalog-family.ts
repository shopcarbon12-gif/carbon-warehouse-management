/**
 * Which garment family a catalogue product belongs to.
 *
 * The catalogue already knows what every product is — "MEN / JEANS", "WOMEN /
 * BODYSUIT" — and that is better information than anything a silhouette can be
 * asked to infer. Reading it means the item card offers Waist and Inseam for a
 * pair of evening pants instead of Chest and Sleeve, and the Size Grading page
 * starts on the right family instead of guessing from the outline and being
 * corrected.
 *
 * The strings come from two places that disagree in format: the WMS keeps
 * category and subcategory in separate columns ("MEN", "EVENING PANTS") while
 * Shopify packs them into one product type ("MEN >> EVENING PANTS", and
 * occasionally "MEN >> T- SHIRT" with a stray space). Both are normalised here,
 * so one table covers the whole catalogue.
 *
 * Every mapping below was taken from the live catalogue on 2026-10-02, not
 * invented: 1,773 WMS matrices and 776 Shopify products. Anything not listed
 * falls through to null, which the UI treats as "ask the operator" rather than
 * guessing — a wrong family quietly produces plausible, wrong numbers.
 */

import type { GarmentType } from "./garment";

/** Products that are not flat garments and cannot be measured this way. */
export type NotMeasurable = "accessory" | "footwear" | "non-garment" | "set";

export type FamilyGuess =
  | { kind: "garment"; type: GarmentType; why: string }
  | { kind: "not-measurable"; reason: NotMeasurable; why: string }
  | null;

/** "MEN >> T- SHIRT" → "T-SHIRT"; "  jeans " → "JEANS". */
function normalise(value: string): string {
  const last = value.split(">>").pop() ?? value;
  return last
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/* Written as the catalogue spells them, including the variants that exist only
   because someone typed the same thing twice. */
const GARMENT: Record<string, GarmentType> = {
  // Tops — anything worn on the upper body and measured chest/length/hem.
  "T SHIRT": "top",
  "TSHIRT": "top",
  "TEE": "top",
  "TEES": "top",
  "TOP": "top",
  "TOPS": "top",
  "TANK TOP": "top",
  "VEST": "top",
  "SWEATSHIRT": "top",
  "SWEATSHIRTS": "top",
  "HOODIE": "top",
  "HOODIES": "top",
  "SWEATER": "top",
  "SWEATERS": "top",
  "KNITWEAR": "top",
  // Button-throughs and outerwear measure exactly like a top laid flat. They
  // are listed rather than left to fall through so the operator is not asked a
  // question the catalogue already answers; collar and cuff points come later.
  "SHIRT": "top",
  "SHIRTS": "top",
  "BUTTON SHIRT": "top",
  "DENIM SHIRT": "top",
  "BLOUSE": "top",
  "BLOUSES": "top",
  "JACKET": "top",
  "JACKETS": "top",
  "DENIM JACKET": "top",
  "COAT": "top",
  "COATS": "top",
  "BLAZER": "top",

  // Legs.
  "JEANS": "trousers",
  "PANTS": "trousers",
  "TROUSERS": "trousers",
  "SWEATPANTS": "trousers",
  "EVENING PANTS": "trousers",
  "LEGGING": "trousers",
  "LEGGINGS": "trousers",
  "JOGGERS": "trousers",

  "SHORTS": "shorts",
  // Men's swimwear in this catalogue is swim shorts; the women's one-piece is
  // filed under SWIMSUIT and handled below.
  "SWIMWEAR": "shorts",
  "SWIM SHORTS": "shorts",
  "BOARDSHORTS": "shorts",

  "DRESS": "dress",
  "DRESSES": "dress",

  "SKIRT": "skirt",
  "SKIRTS": "skirt",

  // Torso and legs in one piece. Measured as its own family: treating a romper
  // as shorts throws away the entire upper body, and treating it as a top
  // misreads the leg split as a hem.
  "BODYSUIT": "onepiece",
  "BODYSUITS": "onepiece",
  "ROMPER": "onepiece",
  "ROMPERS": "onepiece",
  "PLAYSUIT": "onepiece",
  "JUMPSUIT": "onepiece",
  "OVERALL": "onepiece",
  "OVERALLS": "onepiece",
  "DUNGAREES": "onepiece",
  "SWIMSUIT": "onepiece",
  "SWIMSUITS": "onepiece",
};

const REFUSED: Record<string, NotMeasurable> = {
  ACCESSORIES: "accessory",
  ACCESSORY: "accessory",
  BELT: "accessory",
  BELTS: "accessory",
  HAT: "accessory",
  HATS: "accessory",
  BAG: "accessory",
  BAGS: "accessory",
  JEWELRY: "accessory",
  SOCKS: "accessory",
  SHOES: "footwear",
  SHOE: "footwear",
  BOOTS: "footwear",
  SNEAKERS: "footwear",
  "GIFT CARD": "non-garment",
  GIFTCARD: "non-garment",
  SHIPPING: "non-garment",
  GENERAL: "non-garment",
  // A set is two garments sold together; each piece is measured on its own.
  SET: "set",
  SETS: "set",
};

const REFUSAL_TEXT: Record<NotMeasurable, string> = {
  accessory: "Accessories are not flat garments — there is nothing to measure this way.",
  footwear: "Footwear is not measured here; length and width need a different method.",
  "non-garment": "This is not a garment.",
  set: "A set is two garments — measure each piece on its own SKU.",
};

/**
 * Best guess at the family, from whatever the catalogue holds.
 *
 * Pass the WMS `category` and `subcategory_1`, or a Shopify product type in
 * either argument — the subcategory is checked first because that is where the
 * garment word lives ("MEN" alone says nothing about shape).
 */
export function familyForCategory(category?: string | null, subcategory?: string | null): FamilyGuess {
  for (const raw of [subcategory, category]) {
    const key = normalise(String(raw ?? ""));
    if (!key) continue;
    const refused = REFUSED[key];
    if (refused) return { kind: "not-measurable", reason: refused, why: REFUSAL_TEXT[refused] };
    const type = GARMENT[key];
    if (type) return { kind: "garment", type, why: `catalogue says ${key.toLowerCase()}` };
  }
  return null;
}
