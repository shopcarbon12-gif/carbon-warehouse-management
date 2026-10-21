/**
 * CarbonGradingAI — what the phone app measures, per garment type.
 *
 * The app (apps/carbongradingai) holds none of this itself: it downloads it
 * from GET /api/grading-app/config every time it opens. Changing a list, a
 * definition or a laying instruction here reaches the phone on its next start,
 * with no app update — that is the "desktop changes reach the app" promise in
 * the plan (CarbonGradingAI plan v3, 2026-10-13).
 *
 * The lists are Size AI's published lists, front photo only, with sleeves and
 * legs measured on both sides where Size AI does ("L+R"). The definitions are
 * the standard spec-sheet ones, not house rules (owner, plan v2). Trousers have
 * no hip (owner, plan v3); bodysuits, rompers and overalls use the five points
 * the owner approved.
 *
 * Keys are stable storage names: they become the keys of
 * size_grading_measurements.points_cm. A pair is stored three ways — `sleeveL`,
 * `sleeveR` and their average under the plain key (`sleeve`) — because the size
 * chart uses the average and the web item card already knows the plain keys.
 */

import type { GarmentType } from "./garment";

export type GradingPointKey =
  | "chest" | "waist" | "hip" | "length" | "hem" | "shoulder"
  | "sleeve" | "sleeveL" | "sleeveR" | "cuff" | "cuffL" | "cuffR" | "strap"
  | "rise" | "thighL" | "thighR" | "kneeL" | "kneeR" | "inseam" | "inseamL" | "inseamR"
  | "outseamL" | "outseamR" | "legOpeningL" | "legOpeningR" | "sideLength";

export type GradingPoint = {
  key: GradingPointKey;
  /** The letter on the guide picture and on the result screen. */
  letter: string;
  label: string;
  /** Standard definition, shown in the in-app guide and sent to the AI. */
  rule: string;
  /** For L/R points: the plain key their average is stored under. */
  pairOf?: "sleeve" | "cuff" | "thigh" | "knee" | "inseam" | "outseam" | "legOpening";
  side?: "L" | "R";
  /** Seam-based end points the outline cannot see — placed by the AI assist until the app's own model is trained. */
  hard?: boolean;
  /** Line with a bend point the operator can drag to follow a seam (front rise). */
  bend?: boolean;
};

export type GradingProfileId =
  | "tee" | "jacket" | "campshirt" | "tank" | "camisole"
  | "trousers" | "shorts" | "skirt"
  | "dress-sleeves-short" | "dress-sleeves-long" | "dress-sleeveless" | "dress-slip"
  | "onepiece";

export type GradingProfile = {
  id: GradingProfileId;
  label: string;
  /** Family stored in size_grading_measurements.garment_type and used by the AI. */
  family: GarmentType;
  /** Silhouette the app draws in its guide until the ChatGPT guide picture is in. */
  silhouette: "tee" | "longsleeve" | "jacket" | "tank" | "camisole" | "trousers" | "shorts" | "skirt" | "dress" | "slipdress" | "onepiece";
  points: GradingPoint[];
  /** How to lay it, shown on the guide page and above the capture screen. */
  lay: string;
  /** Where it sits in the phone's type picker: sleeved and sleeveless garments are kept apart (owner, 2026-10-13). */
  group: "sleeves" | "sleeveless" | "bottoms" | "onepiece";
  /** For a sleeved type: the type to offer when the photo shows no sleeves. */
  sleeveless?: GradingProfileId;
  /** How far below the top of the waistband the hip line sits (cm); the outline uses it. Default 18. */
  hipBelowTopCm?: number;
  /**
   * Bottoms: a second photo with the legs spread apart so the crotch lies flat
   * (owner, 2026-10-20). Only these points are taken from it — spreading the
   * legs folds the side seams and twists the hems, so everything else stays
   * on the first photo.
   */
  crotchPhoto?: { keys: GradingPointKey[]; lay: string };
  /**
   * The second photo, for every type that takes one (app 1.1.0+): bottoms with
   * the legs spread for the crotch, tops with the sleeves lifted so the
   * underarms lie flat for the chest (owner, 2026-10-21: "the chest line is
   * folded under the sleeves"). `sidesOk` are the frame edges the garment may
   * run past on it — only the body is measured there. `crotchPhoto` stays for
   * older apps, which read only that.
   */
  secondPhoto?: { keys: GradingPointKey[]; lay: string; title: string; sidesOk: ("left" | "right" | "top" | "bottom")[] };
  /** Guide picture (generated from the ChatGPT prompts), with line ends as fractions of its size. */
  guide?: { image: string; lines: Partial<Record<GradingPointKey, [[number, number], [number, number]]>> };
};

/* ─────────────────────────── definitions ─────────────────────────── */

const LEFT = "the one on the LEFT of the photo";
const RIGHT = "the one on the RIGHT of the photo";

const R = {
  chest: "Straight across, 2.5 cm (1\") below the armpits (where the sleeve's underside meets the body's side edge, at the top of the side seams), side edge to side edge.",
  length: "From the high point of the shoulder (where the shoulder seam meets the collar) straight down to the hem, parallel to the centre front. If a collar or hood lies over that point, use the top of the shoulder right beside the collar.",
  lengthStrap: "From where the strap on the left of the photo is sewn to the top edge of the front, straight down to the hem, parallel to the centre front.",
  shoulder: "From one shoulder seam point to the other, straight across — the shoulder seam point is where the sleeve is sewn on at the top edge (on a drop-shoulder tee it sits inside the bend of the outline).",
  shoulderSleeveless: "Sleeveless: straight across the top of the shoulders, from the outer edge of one shoulder (where the armhole meets the shoulder's top edge) to the outer edge of the other.",
  waistTop: "Straight across at the narrowest point between the chest line and the hem. On a straight-sided garment with no shaping, halfway between the armpit and the hem — never right under the chest line.",
  hem: "Straight across the bottom edge, edge to edge.",
  sleeve: (side: string) => `Sleeve ${side}: from the shoulder seam point (where the sleeve is sewn on, at the top edge) to the end of the sleeve, along the top fold.`,
  cuff: (side: string) => `Sleeve opening, ${side}: straight across the end of the sleeve, edge to edge, square to the sleeve.`,
  strap: "Strap as it lies flat, the strap on the left of the photo: from where it is sewn to the top edge of the front, along the strap, to the top of its fold (where it turns over to the back).",
  waistBottom: "Straight across the top edge of the waistband, button and zip closed, edge to edge.",
  /* Owner's John Denim Shorts, 2026-10-20: "just below the J-stitching" sent the AI to the bottom of the fly,
     5–6 cm too high (factory front rise 25.2 cm with the waistband; one placement gave 20.6). */
  rise: "From the top of the front waistband at centre front, along the front seam, down to the crotch seam point — the fork where the front seam splits into the two inseams (where the four seams meet). On jeans this fork is several centimetres BELOW the bottom of the fly's J-stitching — never at the J-stitch, the zip end or the last fly stitch. It sits at the top of the V where the two inner leg seams meet, a little above the open gap between the legs.",
  thigh: (side: string) => `Thigh, leg ${side}: 2.5 cm (1") below the crotch point, straight across that leg, square to the leg, inside edge to outside edge.`,
  knee: (side: string) => `Knee, leg ${side}: halfway down the inseam, straight across that leg, square to the leg.`,
  inseam: (side: string) => `Inseam, leg ${side}: from the crotch seam point to the hem, along the inside leg seam.`,
  outseam: (side: string) => `Outseam, leg ${side}: from the top of the waistband at the side to the hem, along the outside side seam.`,
  legOpening: (side: string) => `Leg opening, leg ${side}: straight across the hem of that leg, edge to edge, square to the leg.`,
  hipSkirtShorts: "Straight across, 18 cm (7\") below the top of the waistband, side edge to side edge.",
  /* The factory's hip line (BASEN KH 16 CM on the size sheets): 16 cm below the
     bottom of the waistband, which on a 4 cm denim band is 20 cm below its top
     (owner, 2026-10-20: measure it the factory way so sheets can be compared). */
  hipDenim: "Straight across, 20 cm (8\") below the top of the waistband — the factory's line, 16 cm below the bottom of a 4 cm waistband — side edge to side edge.",
  hipDress: "Straight across at the widest point below the waist, side edge to side edge.",
  lengthSkirt: "Centre length: from the top of the waistband at centre front straight down to the hem.",
  sideLength: "Side seam length: from the top of the waistband at the side, along the side seam, to the hem (the left side of the photo).",
  hipOnepiece: "Straight across at the widest point between the waist and the crotch, side edge to side edge (not across the leg openings).",
  lengthOnepiece: "From the high point of the shoulder (or where the strap meets the front) straight down to the crotch: the crotch seam point, or on a bodysuit the bottom edge of the crotch.",
  inseamOnepiece: "Rompers, jumpsuits and overalls: from the crotch seam point to the hem of the leg on the left of the photo, along the inside leg seam. A bodysuit has no inseam — skip it.",
} as const;

const P = {
  chest: { key: "chest", letter: "A", label: "Chest", rule: R.chest },
  length: { key: "length", letter: "D", label: "Body length", rule: R.length },
  shoulder: { key: "shoulder", letter: "E", label: "Shoulder", rule: R.shoulder, hard: true },
  shoulderSleeveless: { key: "shoulder", letter: "E", label: "Shoulder", rule: R.shoulderSleeveless, hard: true },
  lengthStrap: { key: "length", letter: "D", label: "Body length", rule: R.lengthStrap },
  waistTop: { key: "waist", letter: "B", label: "Waist", rule: R.waistTop },
  hem: { key: "hem", letter: "C", label: "Hem", rule: R.hem },
  sleeve: { key: "sleeve", letter: "G", label: "Sleeve length", rule: R.sleeve("on the left of the photo"), hard: true },
  sleeveL: { key: "sleeveL", letter: "G", label: "Sleeve length L", rule: R.sleeve(LEFT), pairOf: "sleeve", side: "L", hard: true },
  sleeveR: { key: "sleeveR", letter: "G", label: "Sleeve length R", rule: R.sleeve(RIGHT), pairOf: "sleeve", side: "R", hard: true },
  cuff: { key: "cuff", letter: "J", label: "Sleeve opening", rule: R.cuff("on the left of the photo") },
  cuffL: { key: "cuffL", letter: "J", label: "Sleeve opening L", rule: R.cuff(LEFT), pairOf: "cuff", side: "L" },
  cuffR: { key: "cuffR", letter: "J", label: "Sleeve opening R", rule: R.cuff(RIGHT), pairOf: "cuff", side: "R" },
  strap: { key: "strap", letter: "S", label: "Strap length", rule: R.strap, hard: true },
  waistBottom: { key: "waist", letter: "A", label: "Waist", rule: R.waistBottom },
  rise: { key: "rise", letter: "I", label: "Front rise", rule: R.rise, hard: true, bend: true },
  thighL: { key: "thighL", letter: "C", label: "Thigh L", rule: R.thigh(LEFT), pairOf: "thigh", side: "L", hard: true },
  thighR: { key: "thighR", letter: "C", label: "Thigh R", rule: R.thigh(RIGHT), pairOf: "thigh", side: "R", hard: true },
  kneeL: { key: "kneeL", letter: "D", label: "Knee L", rule: R.knee(LEFT), pairOf: "knee", side: "L" },
  kneeR: { key: "kneeR", letter: "D", label: "Knee R", rule: R.knee(RIGHT), pairOf: "knee", side: "R" },
  inseamL: { key: "inseamL", letter: "G", label: "Inseam L", rule: R.inseam(LEFT), pairOf: "inseam", side: "L", hard: true },
  inseamR: { key: "inseamR", letter: "G", label: "Inseam R", rule: R.inseam(RIGHT), pairOf: "inseam", side: "R", hard: true },
  outseamL: { key: "outseamL", letter: "H", label: "Outseam L", rule: R.outseam(LEFT), pairOf: "outseam", side: "L" },
  outseamR: { key: "outseamR", letter: "H", label: "Outseam R", rule: R.outseam(RIGHT), pairOf: "outseam", side: "R" },
  legOpeningL: { key: "legOpeningL", letter: "F", label: "Leg opening L", rule: R.legOpening(LEFT), pairOf: "legOpening", side: "L" },
  legOpeningR: { key: "legOpeningR", letter: "F", label: "Leg opening R", rule: R.legOpening(RIGHT), pairOf: "legOpening", side: "R" },
  hipShorts: { key: "hip", letter: "B", label: "Hip", rule: R.hipSkirtShorts },
  hipDenim: { key: "hip", letter: "B", label: "Hip", rule: R.hipDenim },
  hipDress: { key: "hip", letter: "K", label: "Hip", rule: R.hipDress },
  hipOnepiece: { key: "hip", letter: "K", label: "Hip", rule: R.hipOnepiece },
  lengthSkirt: { key: "length", letter: "D", label: "Centre length", rule: R.lengthSkirt },
  sideLength: { key: "sideLength", letter: "L", label: "Side length", rule: R.sideLength },
  lengthOnepiece: { key: "length", letter: "D", label: "Body length", rule: R.lengthOnepiece },
  inseamOnepiece: { key: "inseam", letter: "G", label: "Inseam", rule: R.inseamOnepiece, hard: true },
} satisfies Record<string, GradingPoint>;

const LAY = {
  top: "Front up, buttons and zip closed, flat and smooth with no folds. Sleeves out to the sides, slightly down, lying straight. Collar at the top of the screen.",
  jacket: "Front up, zipped or buttoned, collar flat. Sleeves out to the sides, slightly down, lying straight. Collar at the top of the screen.",
  sleeveless: "Front up, flat and smooth, straps lying straight up. Top edge at the top of the screen.",
  trousers: "Front up, button and zip closed, legs straight with a small gap from the crotch down, no folds. Waistband at the top of the screen.",
  shorts: "Front up, button and zip closed, legs straight with a small gap between them. Waistband at the top of the screen.",
  skirt: "Front up, zip closed, flat and smooth, hem spread to its natural width. Waistband at the top of the screen.",
  dress: "Front up, zip or buttons closed, flat and smooth, sleeves out to the sides if it has them. Top at the top of the screen.",
  onepiece: "Front up, closed, flat and smooth, legs straight with a small gap, sleeves out if it has them. Top at the top of the screen.",
  crotch: "Second photo, for the crotch only: keep it front up, then pull the legs apart to the sides so the crotch lies flat and its seams show. Waistband at the top of the screen.",
};

/** The points the crotch photo gives on shorts (they all end at the crotch seam point). */
const CROTCH = { keys: ["rise", "inseamL", "inseamR"] as GradingPointKey[], lay: LAY.crotch };
/* Trousers: the rise only. Spread, the long legs run out of the frame and the
   inseams were cut short (owner's Colin Evening Pants 29, 2026-10-21: 44 and
   54 cm) — the inseam stays on the first photo, where the hems are in it. */
const CROTCH_TROUSERS = { keys: ["rise"] as GradingPointKey[], lay: LAY.crotch };
const SECOND_SHORTS = { ...CROTCH, title: "crotch", sidesOk: ["left", "right"] as ("left" | "right")[] };
const SECOND_TROUSERS = { ...CROTCH_TROUSERS, title: "crotch", sidesOk: ["left", "right", "bottom"] as ("left" | "right" | "bottom")[] };
const SECOND_TOP = {
  keys: ["chest", "waist"] as GradingPointKey[],
  lay: "Second photo, for the chest only: keep it front up, then lift both sleeves up and out so the underarms lie flat and the side seams show. The sleeves may run past the frame.",
  title: "sleeves up",
  sidesOk: ["left", "right", "top"] as ("left" | "right" | "top")[],
};

export const GRADING_PROFILES: GradingProfile[] = [
  {
    id: "tee", label: "T-shirt / top / shirt / hoodie", family: "top", group: "sleeves", sleeveless: "tank", silhouette: "tee", lay: LAY.top,
    points: [P.chest, P.length, P.shoulder, P.waistTop, P.hem, P.sleeveL, P.sleeveR, P.cuffL, P.cuffR],
    secondPhoto: SECOND_TOP,
  },
  {
    id: "jacket", label: "Jacket / coat", family: "top", group: "sleeves", sleeveless: "tank", silhouette: "jacket", lay: LAY.jacket,
    points: [P.chest, P.length, P.shoulder, P.sleeve, P.cuff, P.hem],
    secondPhoto: { ...SECOND_TOP, keys: ["chest"] },
  },
  {
    id: "campshirt", label: "Short-sleeve jacket / camp shirt", family: "top", group: "sleeves", sleeveless: "tank", silhouette: "tee", lay: LAY.top,
    points: [P.chest, P.length, P.shoulder, P.waistTop, P.hem, P.sleeve, P.cuff],
    secondPhoto: SECOND_TOP,
  },
  {
    id: "tank", label: "Tank / vest", family: "top", group: "sleeveless", silhouette: "tank", lay: LAY.sleeveless,
    points: [P.chest, P.length, P.waistTop, P.hem, P.shoulderSleeveless],
  },
  {
    id: "camisole", label: "Camisole", family: "top", group: "sleeveless", silhouette: "camisole", lay: LAY.sleeveless,
    points: [P.chest, P.lengthStrap, P.waistTop, P.hem, P.strap],
  },
  {
    id: "trousers", label: "Trousers / jeans / leggings / joggers", family: "trousers", group: "bottoms", silhouette: "trousers", lay: LAY.trousers,
    points: [P.waistBottom, P.rise, P.thighL, P.thighR, P.kneeL, P.kneeR, P.inseamL, P.inseamR, P.outseamL, P.outseamR, P.legOpeningL, P.legOpeningR],
    crotchPhoto: CROTCH_TROUSERS,
    secondPhoto: SECOND_TROUSERS,
  },
  {
    id: "shorts", label: "Shorts / swim shorts", family: "shorts", group: "bottoms", silhouette: "shorts", lay: LAY.shorts,
    /* Thigh added (owner, 2026-10-20: the WMS size card and the factory sheets have it). */
    points: [P.waistBottom, P.hipDenim, P.rise, P.thighL, P.thighR, P.inseamL, P.inseamR, P.outseamL, P.outseamR, P.legOpeningL, P.legOpeningR],
    hipBelowTopCm: 20,
    crotchPhoto: CROTCH,
    secondPhoto: SECOND_SHORTS,
  },
  {
    id: "skirt", label: "Skirt", family: "skirt", group: "bottoms", silhouette: "skirt", lay: LAY.skirt,
    points: [P.waistBottom, P.hipShorts, P.lengthSkirt, P.sideLength, P.hem],
  },
  {
    id: "dress-sleeves-short", label: "Dress, short sleeves", family: "dress", group: "sleeves", sleeveless: "dress-sleeveless", silhouette: "dress", lay: LAY.dress,
    points: [P.chest, P.length, P.waistTop, P.hipDress, P.shoulder, P.hem, P.sleeveL, P.sleeveR, P.cuffL, P.cuffR],
  },
  {
    id: "dress-sleeves-long", label: "Dress, long sleeves", family: "dress", group: "sleeves", sleeveless: "dress-sleeveless", silhouette: "dress", lay: LAY.dress,
    points: [P.chest, P.length, P.waistTop, P.hipDress, P.shoulder, P.hem, P.sleeve, P.cuff],
  },
  {
    id: "dress-sleeveless", label: "Dress, sleeveless", family: "dress", group: "sleeveless", silhouette: "dress", lay: LAY.dress,
    points: [P.chest, P.length, P.waistTop, P.hipDress, P.hem, P.shoulderSleeveless],
  },
  {
    id: "dress-slip", label: "Slip dress", family: "dress", group: "sleeveless", silhouette: "slipdress", lay: LAY.dress,
    points: [P.chest, P.lengthStrap, P.waistTop, P.hipDress, P.hem, P.strap],
  },
  {
    id: "onepiece", label: "Bodysuit / romper / overall", family: "onepiece", group: "onepiece", silhouette: "onepiece", lay: LAY.onepiece,
    points: [P.chest, P.lengthOnepiece, P.waistTop, P.hipOnepiece, P.inseamOnepiece],
  },
];

export const PROFILE_BY_ID = Object.fromEntries(GRADING_PROFILES.map((p) => [p.id, p])) as Record<GradingProfileId, GradingProfile>;

/* ───────────────────────── catalogue → profile ───────────────────────── */

function normalise(value: string): string {
  const last = value.split(">>").pop() ?? value;
  return last.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

const BY_SUBCATEGORY: Record<string, GradingProfileId> = {
  "T SHIRT": "tee", TSHIRT: "tee", TEE: "tee", TEES: "tee", TOP: "tee", TOPS: "tee",
  SWEATSHIRT: "tee", SWEATSHIRTS: "tee", HOODIE: "tee", HOODIES: "tee", SWEATER: "tee", SWEATERS: "tee",
  KNITWEAR: "tee", SHIRT: "tee", SHIRTS: "tee", "BUTTON SHIRT": "tee", "DENIM SHIRT": "tee",
  BLOUSE: "tee", BLOUSES: "tee", POLO: "tee",
  "TANK TOP": "tank", TANK: "tank", VEST: "tank",
  JACKET: "jacket", JACKETS: "jacket", "DENIM JACKET": "jacket", COAT: "jacket", COATS: "jacket", BLAZER: "jacket",
  JEANS: "trousers", PANTS: "trousers", TROUSERS: "trousers", SWEATPANTS: "trousers", "EVENING PANTS": "trousers",
  LEGGING: "trousers", LEGGINGS: "trousers", JOGGERS: "trousers",
  SHORTS: "shorts", SWIMWEAR: "shorts", "SWIM SHORTS": "shorts", BOARDSHORTS: "shorts",
  SKIRT: "skirt", SKIRTS: "skirt",
  DRESS: "dress-sleeveless", DRESSES: "dress-sleeveless",
  BODYSUIT: "onepiece", BODYSUITS: "onepiece", ROMPER: "onepiece", ROMPERS: "onepiece", PLAYSUIT: "onepiece",
  JUMPSUIT: "onepiece", OVERALL: "onepiece", OVERALLS: "onepiece", DUNGAREES: "onepiece",
  SWIMSUIT: "onepiece", SWIMSUITS: "onepiece",
};

const NOT_MEASURED: Record<string, string> = {
  ACCESSORIES: "Accessories are not measured.", ACCESSORY: "Accessories are not measured.",
  SHOES: "Shoes are not measured.", SHOE: "Shoes are not measured.", BOOTS: "Shoes are not measured.", SNEAKERS: "Shoes are not measured.",
  SET: "A set is two garments — measure each piece on its own product.", SETS: "A set is two garments — measure each piece on its own product.",
  GENERAL: "Not a garment.", "GIFT CARD": "Not a garment.", SHIPPING: "Not a garment.",
};

export type ProfileGuess =
  | { kind: "profile"; profile: GradingProfileId; why: string }
  | { kind: "not-measured"; why: string }
  | { kind: "unknown"; why: string };

/** Best profile for a product, from its catalogue words and its name ("Karina Crop Tank" → tank). */
export function profileForProduct(category?: string | null, subcategory?: string | null, name?: string | null): ProfileGuess {
  const title = ` ${normalise(String(name ?? ""))} `;
  for (const raw of [subcategory, category]) {
    const key = normalise(String(raw ?? ""));
    if (!key) continue;
    if (NOT_MEASURED[key]) return { kind: "not-measured", why: NOT_MEASURED[key] };
    let id = BY_SUBCATEGORY[key];
    if (!id) continue;
    /* The name refines the family: a women's TOPS row can be a cami or a tank,
       a DRESS row a slip dress. The operator can still switch on the phone. */
    if (id === "tee" || id === "tank") {
      if (/ (CAMI|CAMISOLE|BANDEAU|TUBE) /.test(title)) id = "camisole";
      else if (/ (TANK|SINGLET|SLEEVELESS|VEST) /.test(title)) id = "tank";
    }
    if (id === "dress-sleeveless") {
      if (/ SLIP /.test(title) || / CAMI /.test(title)) id = "dress-slip";
      else if (/ (LONG SLEEVE|LONGSLEEVE) /.test(title)) id = "dress-sleeves-long";
      else if (/ (SHORT SLEEVE|T SHIRT DRESS|TEE DRESS|SHIRT DRESS) /.test(title)) id = "dress-sleeves-short";
    }
    if (id === "jacket" && / VEST /.test(title)) id = "tank";
    return { kind: "profile", profile: id, why: `catalogue says ${key.toLowerCase()}` };
  }
  return { kind: "unknown", why: "The catalogue does not say what this garment is — pick the type." };
}

/* ───────────────────────────── sizes ───────────────────────────── */

const LETTER_LADDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "XXXL", "4XL", "5XL"];

/** Sort key for a size label: letters on the usual ladder, numbers by value, the rest last. */
export function sizeRank(size: string | null | undefined): number {
  const s = String(size ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return 1e6;
  const alias: Record<string, string> = { "2XL": "XXL", "3XL": "XXXL", XXXXL: "4XL", "2XS": "XXS" };
  const letter = LETTER_LADDER.indexOf(alias[s] ?? s);
  if (letter >= 0) return letter * 10;
  const num = Number.parseFloat(s.replace(",", "."));
  if (Number.isFinite(num)) return 1000 + num * 10;
  return 1e5;
}

/** Points of a profile that the AI assist places (seam-based). */
export function hardKeys(profile: GradingProfile): GradingPointKey[] {
  return profile.points.filter((p) => p.hard).map((p) => p.key);
}

/**
 * The stored map for a set of L/R readings: every point under its own key, and
 * each pair's average under the plain key — rounded to 0.1 cm.
 */
export function withPairAverages(profile: GradingProfile, cm: Partial<Record<GradingPointKey, number>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(cm)) if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = Math.round(v * 10) / 10;
  const pairs = new Map<string, number[]>();
  for (const p of profile.points) {
    if (!p.pairOf) continue;
    const v = out[p.key];
    if (v === undefined) continue;
    pairs.set(p.pairOf, [...(pairs.get(p.pairOf) ?? []), v]);
  }
  for (const [plain, vs] of pairs) out[plain] = Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 10) / 10;
  return out;
}

/** L/R pairs that differ by more than 1 cm — a twisted leg or a sleeve not laid straight. */
export function pairMismatches(profile: GradingProfile, cm: Record<string, number>, limitCm = 1): string[] {
  const seen = new Map<string, number[]>();
  for (const p of profile.points) {
    if (!p.pairOf || cm[p.key] === undefined) continue;
    seen.set(p.pairOf, [...(seen.get(p.pairOf) ?? []), cm[p.key]]);
  }
  const out: string[] = [];
  for (const [plain, vs] of seen) {
    if (vs.length === 2 && Math.abs(vs[0] - vs[1]) > limitCm) out.push(`${plain} L/R differ by ${Math.abs(vs[0] - vs[1]).toFixed(1)} cm`);
  }
  return out;
}
