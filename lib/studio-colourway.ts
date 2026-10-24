/**
 * When may a saved colourway (studio_color_runs: a colour photo + its read
 * colour name, keyed on product + colour) recolour a Studio run?
 *
 * Owner, 2026-10-23: "i was doing black shirt in the studio yet i always get
 * the white shirt". Damian Shirt's BLACK colourway (saved Oct 3) held a
 * "bright white" photo, so every BLACK run was sent as a dye change to white —
 * over item photos and a spec that both said black. About a dozen other saved
 * colourways name a different colour than the one they are filed under.
 *
 *   "already"  — the item photos (their spec's Garment line) already show this
 *                colour: nothing to recolour, the colourway is not sent.
 *   "mismatch" — the colourway names a different colour family than the
 *                colour picked (BLACK filed with "bright white"): not sent, and
 *                the Studio says so instead of silently recolouring.
 *   "apply"    — send it (also when a colour word is not recognised: no guess).
 */

/* Near shades sit in both neighbouring families (taupe, mushroom, tan,
   charcoal…), so only a clearly different colour counts as a mismatch. */
const FAMILIES: Record<string, string[]> = {
  black: ["black", "jet", "onyx", "ebony", "charcoal"],
  white: ["white", "off-white", "offwhite", "ivory", "cream", "ecru", "bone", "unbleached", "optic"],
  grey: ["grey", "gray", "charcoal", "heather", "ash", "silver", "slate", "marl", "smoke"],
  beige: ["beige", "sand", "tan", "camel", "khaki", "stone", "oatmeal", "taupe", "nude", "cream", "ecru", "latte", "mushroom", "mocha"],
  brown: ["brown", "chocolate", "coffee", "mocha", "tan", "camel", "cognac", "walnut", "chestnut", "mushroom", "bronze", "rust", "taupe", "khaki"],
  blue: ["blue", "navy", "denim", "indigo", "sky", "cobalt", "azure", "royal"],
  teal: ["teal", "turquoise", "aqua", "cyan", "petrol"],
  green: ["green", "olive", "sage", "mint", "emerald", "forest", "lime", "khaki"],
  red: ["red", "burgundy", "wine", "maroon", "crimson", "cherry", "brick"],
  pink: ["pink", "rose", "blush", "fuchsia", "magenta"],
  purple: ["purple", "lavender", "lilac", "violet", "plum", "mauve"],
  yellow: ["yellow", "mustard", "gold", "lemon", "golden"],
  orange: ["orange", "rust", "coral", "peach", "terracotta", "apricot"],
};

/** Colour families a colour text names, e.g. "jet black" → {black}. */
export function colourFamilies(text: string | null | undefined): Set<string> {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/off[\s-]white/g, "offwhite")
    .split(/[^a-z]+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const [fam, list] of Object.entries(FAMILIES)) {
    if (words.some((w) => list.includes(w))) out.add(fam);
  }
  return out;
}

const overlaps = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));

/** The main colour of a description: "cream with black abstract stripes" →
 *  "cream" (Orson Shirt: a black-stripe print is not a black shirt). */
function mainColour(text: string): string {
  return String(text ?? "").split(/\bwith\b|\band\b|[,/;—]/i)[0] ?? "";
}

export type ColourwayDecision = "apply" | "already" | "mismatch";

export function colourwayDecision(input: {
  /** The colour picked in the Studio (the product's colour option), e.g. "BLACK". */
  colorKey: string;
  /** The saved colourway's colour name (read from its photo), e.g. "bright white — …". */
  colourwayName: string;
  /** The spec's Garment colour ("1. Garment: T-SHIRT — black") — what the item photos show. */
  specGarmentColour: string;
}): ColourwayDecision {
  const key = colourFamilies(input.colorKey);
  if (!key.size) return "apply";
  if (overlaps(key, colourFamilies(mainColour(input.specGarmentColour)))) return "already";
  const name = colourFamilies(mainColour(input.colourwayName));
  if (name.size && !overlaps(key, name)) return "mismatch";
  return "apply";
}
