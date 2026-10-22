/**
 * Search tags for the storefront (owner, 2026-10-22: "the search doesn't give
 * the right results"). Shopify's search reads a product's title, type,
 * variants and tags — so a red dress, a pair of baggy jeans or a ripped pair
 * is only found by those words if they are on the product. The catalogue
 * carries them in places search does not look (the colour option, the fit
 * collection, the description), and the product type is inconsistent
 * ("MEN >> JEANS" vs "JEANS"), so a search for "men shorts" missed half of them.
 *
 * searchTagsFor() turns what is already known about a product into the plain
 * words a shopper types: gender, colour family, garment words and their usual
 * synonyms, fit, and a few construction words read from the description.
 * Only real facts — a word is added only when the product shows it.
 *
 * Tags are only ever added (scripts/apply-search-tags.mjs uses tagsAdd); the
 * SEO publish keeps any of these when it rewrites a product's tags
 * (app/api/shopify/seo/write/route.ts), so they survive a rewrite.
 */

export type SearchTagInput = {
  title: string;
  productType?: string | null;
  description?: string | null;
  /** Values of the colour option, e.g. ["BLUE WASHED", "LIGHT BLUE"]. */
  colours?: string[];
  /** Handles of the collections the product is in. */
  collections?: string[];
};

const COLOUR_WORDS: [RegExp, string[]][] = [
  [/\bblack\b/, ["black"]],
  [/\bwhite\b|\boptic white\b|\bivory\b/, ["white"]],
  [/\bcream\b|\boff ?white\b|\becru\b/, ["cream", "off white"]],
  [/\bnavy\b/, ["navy", "blue"]],
  [/\bblue\b|\bdenim blue\b|\bindigo\b/, ["blue"]],
  [/\bteal\b|\bturquoise\b/, ["teal", "blue"]],
  [/\bgr[ae]y\b|\bcharcoal\b|\bsilver\b/, ["grey", "gray"]],
  [/\bred\b|\bburgundy\b|\bwine\b|\bmaroon\b/, ["red"]],
  [/\bburgundy\b|\bwine\b|\bmaroon\b/, ["burgundy"]],
  [/\bgreen\b|\bolive\b|\bsage\b|\bmint\b|\bkhaki green\b|\barmy\b/, ["green"]],
  [/\bolive\b|\barmy\b/, ["olive"]],
  [/\bbeige\b|\bsand\b|\bstone\b|\bnude\b|\btaupe\b/, ["beige"]],
  [/\bkhaki\b/, ["khaki"]],
  [/\bbrown\b|\bchocolate\b|\bcamel\b|\bcoffee\b|\bmocha\b|\btan\b/, ["brown"]],
  [/\bpink\b|\brose\b|\bfuchsia\b|\bblush\b/, ["pink"]],
  [/\bpeach\b|\bcoral\b/, ["peach"]],
  [/\bpurple\b|\blilac\b|\blavender\b|\bviolet\b/, ["purple"]],
  [/\byellow\b|\bmustard\b/, ["yellow"]],
  [/\borange\b|\brust\b/, ["orange"]],
  [/\bgold\b/, ["gold"]],
  [/\bwashed\b|\bacid\b/, ["washed"]],
];

/** Garment words, from the product type and the title (first match wins per rule). */
const GARMENTS: { test: (t: string, title: string) => boolean; tags: string[] }[] = [
  { test: (t, n) => /\bjeans?\b/.test(t) || /\bjeans\b/.test(n), tags: ["jeans", "denim"] },
  { test: (t, n) => /\bshorts?\b/.test(t) || /\bshorts\b/.test(n), tags: ["shorts"] },
  { test: (_t, n) => /\bdenim shorts\b|\bjean shorts\b/.test(n), tags: ["denim shorts", "jean shorts", "jorts"] },
  { test: (t, n) => /\bt- ?shirts?\b|\btees?\b/.test(t) || /\bt-shirt\b|\btee\b/.test(n), tags: ["t-shirt", "tee", "tshirt"] },
  { test: (_t, n) => /\bpolo\b/.test(n), tags: ["polo", "polo shirt"] },
  { test: (t, n) => /\bbutton shirt\b|\bdenim shirt\b|^shirts?$/.test(t) || (/\bshirt\b/.test(n) && !/\bt-shirt\b|\bpolo\b|\bsweatshirt\b/.test(n)), tags: ["shirt", "button up", "button down"] },
  { test: (t, n) => /\bhood(ie|ies)\b/.test(t) || /\bhoodie\b/.test(n), tags: ["hoodie", "sweatshirt"] },
  { test: (t, n) => /\bsweatshirts?\b|\bsweaters?\b|\bknitwear\b/.test(t) || /\bsweatshirt\b|\bsweater\b|\bcrewneck\b/.test(n), tags: ["sweatshirt", "sweater"] },
  { test: (t, n) => /\bdress(es)?\b/.test(t) || /\bdress\b/.test(n), tags: ["dress"] },
  { test: (_t, n) => /\bmini\b/.test(n) && /\bdress\b/.test(n), tags: ["mini dress"] },
  { test: (_t, n) => /\bmidi\b/.test(n), tags: ["midi dress"] },
  { test: (_t, n) => /\bmaxi\b/.test(n), tags: ["maxi dress"] },
  { test: (t, n) => /\btops?\b|\bblouses?\b/.test(t) || /\btop\b|\bblouse\b/.test(n), tags: ["top"] },
  { test: (_t, n) => /\bcrop\b/.test(n), tags: ["crop top"] },
  { test: (t, n) => /\btank\b/.test(t) || /\btank\b/.test(n), tags: ["tank top", "tank"] },
  { test: (t, n) => /\bpants\b|\btrousers\b|\bjoggers?\b|\bsweatpants\b/.test(t) || /\bpants\b|\btrousers\b|\bjoggers?\b/.test(n), tags: ["pants", "trousers"] },
  { test: (_t, n) => /\bcargo\b/.test(n), tags: ["cargo", "cargo pants"] },
  { test: (t, n) => /\bjoggers?\b|\bsweatpants\b/.test(t) || /\bjoggers?\b|\bsweatpants\b/.test(n), tags: ["joggers", "sweatpants"] },
  { test: (t, n) => /\bjackets?\b|\bcoats?\b|\bblazers?\b/.test(t) || /\bjacket\b|\bcoat\b|\bblazer\b|\bpuffer\b/.test(n), tags: ["jacket", "outerwear"] },
  { test: (_t, n) => /\bdenim jacket\b/.test(n), tags: ["denim jacket", "jean jacket"] },
  { test: (_t, n) => /\bvest\b|\bpuffer vest\b/.test(n), tags: ["vest"] },
  { test: (t, n) => /\bsets?\b/.test(t) || /\bset\b|\b2 pieces?\b|\btwo piece\b/.test(n), tags: ["set", "matching set", "two piece"] },
  { test: (t, n) => /\bswim/.test(t) || /\bswim/.test(n), tags: ["swimwear", "swim shorts", "swim trunks"] },
  { test: (t, n) => /\bskirts?\b/.test(t) || /\bskirt\b/.test(n), tags: ["skirt"] },
  { test: (t, n) => /\bbodysuits?\b/.test(t) || /\bbodysuit\b/.test(n), tags: ["bodysuit"] },
  { test: (t, n) => /\brompers?\b|\bplaysuits?\b/.test(t) || /\bromper\b|\bplaysuit\b/.test(n), tags: ["romper"] },
  { test: (t, n) => /\bjumpsuits?\b/.test(t) || /\bjumpsuit\b/.test(n), tags: ["jumpsuit"] },
  { test: (t, n) => /\boveralls?\b/.test(t) || /\boverall\b/.test(n), tags: ["overalls"] },
  { test: (t, n) => /\bleggings?\b/.test(t) || /\blegging\b/.test(n), tags: ["leggings"] },
  { test: (t) => /\bshoes?\b|\bsneakers?\b|\bboots?\b/.test(t), tags: ["shoes"] },
];

/** Fit, from the fit collections the owner keeps (handles, see the size-guide router). */
const FITS: [RegExp, string[]][] = [
  [/baggy/, ["baggy", "loose fit", "relaxed fit"]],
  [/super-skinny/, ["super skinny", "skinny"]],
  [/(^|-)skinny/, ["skinny", "skinny fit"]],
  [/(^|-)slim/, ["slim", "slim fit"]],
  [/ankle-zip/, ["ankle zip"]],
  [/flare/, ["flare", "flared"]],
  [/wide-leg/, ["wide leg"]],
  [/straight/, ["straight leg"]],
];

/** Construction words read from the description (the SEO copy describes the garment from its photos). */
const FEATURES: [RegExp, string[]][] = [
  [/\bripped\b|\bdistress(ed|ing)\b|\bdestroyed\b|\brips?\b/, ["ripped", "distressed"]],
  [/\bstretch(y)?\b|\belastane\b|\bspandex\b/, ["stretch"]],
  [/\bhigh[- ](waist(ed)?|rise)\b/, ["high waisted"]],
  [/\boversized\b/, ["oversized"]],
  [/\bgraphic\b|\bprinted\b|\bprint\b/, ["graphic"]],
];

function gender(input: SearchTagInput): string[] {
  const t = String(input.productType ?? "").toUpperCase();
  const cols = input.collections ?? [];
  const women = /^WOMEN\b/.test(t) || cols.some((h) => /women/.test(h));
  const men = /^MEN\b/.test(t) || cols.some((h) => /(^|-)men($|-)/.test(h) && !/women/.test(h));
  if (women && !men) return ["women", "womens", "ladies"];
  if (men && !women) return ["men", "mens"];
  return [];
}

/**
 * The description, without its styling advice: "pair it with high-waisted
 * jeans" or "wear it with distressed denim" describes another garment, and
 * would tag a crop top as high-waisted (seen on the catalogue, 2026-10-22).
 */
function ownDescription(text: string): string {
  return text
    .toLowerCase()
    .split(/(?<=[.!?])\s*|\n+/)
    .filter((s) => !/\b(pair(s|ed|ing)?|wear (it|them|this)|style (it|them|this)|styling|style tips?|how to style|layer(ed|ing)? (it|them)|goes with|team (it|them)|match(es)? with|size up|perfect with|try (it|them))\b/.test(s))
    .join(" ");
}

export function searchTagsFor(input: SearchTagInput): string[] {
  const type = String(input.productType ?? "").split(">>").pop()!.trim().toLowerCase();
  const title = String(input.title ?? "").toLowerCase();
  const desc = ownDescription(String(input.description ?? ""));
  const out = new Set<string>(gender(input));
  for (const g of GARMENTS) if (g.test(type, title)) g.tags.forEach((x) => out.add(x));
  const colourText = (input.colours ?? []).join(" | ").toLowerCase();
  for (const [re, tags] of COLOUR_WORDS) if (re.test(colourText)) tags.forEach((x) => out.add(x));
  for (const h of input.collections ?? []) for (const [re, tags] of FITS) if (re.test(h)) tags.forEach((x) => out.add(x));
  for (const [re, tags] of FEATURES) if (re.test(desc) || re.test(title)) tags.forEach((x) => out.add(x));
  // High-waisted describes a bottom or a one-piece, never a top.
  const bottom = ["jeans", "shorts", "pants", "skirt", "leggings", "jumpsuit", "romper", "overalls", "joggers"].some((g) => out.has(g));
  if (out.has("high waisted") && !bottom) out.delete("high waisted");
  // Graphic only means something on tops.
  if (out.has("graphic") && !out.has("t-shirt") && !out.has("top") && !out.has("hoodie") && !out.has("sweatshirt")) out.delete("graphic");
  if (out.has("graphic") && out.has("t-shirt")) out.add("graphic tee");
  return [...out];
}

/** Every tag searchTagsFor can produce — the SEO publish keeps these when it rewrites tags. */
export const SEARCH_TAG_VOCAB: ReadonlySet<string> = new Set([
  "men", "mens", "women", "womens", "ladies", "graphic tee",
  ...COLOUR_WORDS.flatMap(([, t]) => t),
  ...GARMENTS.flatMap((g) => g.tags),
  ...FITS.flatMap(([, t]) => t),
  ...FEATURES.flatMap(([, t]) => t),
]);
