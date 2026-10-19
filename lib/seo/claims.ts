/**
 * What SEO copy may and may not say about a product.
 *
 * The optimizer writes from the product photos. A photo shows how a garment
 * LOOKS; it cannot show what it is made of, how it feels, how it fits, how to
 * wash it, how long it is or where it was made — and the previous description
 * cannot either: it was written by the same kind of model and is how claims
 * like "100% cotton" and "breathable" got onto pages nobody had checked. The
 * WMS holds no verified fabric, care, fit or measurement data, so those claims
 * have no allowed source at all and are removed, not argued with.
 *
 * Also removed, by the owner's rules: labels and patches (the CARBON JEANS
 * waistband label is not a reason to buy), the logo described by its shape
 * ("hexagon logo" — it is the CARBON logo), "Carbon Jeans" as the brand, and
 * on a set piece any wording that says the purchase includes the other piece
 * (each piece of a set is its own product at its own price).
 *
 * A word that is part of the product's own name is never a claim: "Bracelet Z
 * Leather" may say leather, "Royal Satin Top Set" may say satin.
 *
 * Pure and dependency-free so it runs in the optimizer, the bulk script and
 * the tests alike. See docs/seo/SEO-ENGINE-V2-SPEC.md §D3.
 */

export type ClaimKind =
  | "material"
  | "feel"
  | "care"
  | "fit"
  | "measurement"
  | "origin"
  | "label"
  | "logo-shape"
  | "brand"
  | "set-contents"
  | "cliche";

export type ClaimFinding = { kind: ClaimKind; term: string; sentence: string };

type Rule = { kind: ClaimKind; re: RegExp; label?: string };

const RULES: Rule[] = [
  /* "\b" after "%" never matches before a space, which is how a rev-2 draft of
     this regex missed "100% recycled" — so the percentage has no trailing \b. */
  { kind: "material", re: /\b\d{1,3}(?:[.,]\d+)?\s?%/gi, label: "fabric percentage" },
  {
    kind: "material",
    re: /\b(cotton|polyester|poly|elastane|spandex|lycra|linen|wool|woolen|cashmere|silk|silky|viscose|rayon|modal|nylon|acrylic|leather|leatherette|suede|faux|fur|vegan|recycled|organic|bamboo|hemp|fleece|polyamide)\b/gi,
  },
  {
    kind: "feel",
    re: /\b(stretch|stretchy|stretchable|soft|softness|breathable|lightweight|light-weight|heavyweight|durable|moisture[- ]wicking|warm|cozy|cosy|water[- ]?(?:proof|resistant)|wrinkle[- ]free|comfortable|comfort|comfy|plush|cool(?:ing)? to wear|thick|premium quality|high[- ]quality|quality fabric)\b/gi,
  },
  { kind: "care", re: /\b(machine[- ]wash(?:able)?|hand[- ]wash|dry[- ]clean|tumble[- ]dry|easy[- ]care|easy to care)\b/gi },
  {
    kind: "fit",
    re: /\b(true to size|runs (?:small|large|big)|size (?:up|down)|fits? (?:true|perfectly|like a glove)|(?:slim|regular|relaxed|loose|skinny|tailored|oversized|athletic|straight)[- ]fit|(?:high|mid|low)[- ]rise|flattering fit|figure[- ]hugging)\b/gi,
  },
  { kind: "measurement", re: /\b\d+(?:[.,]\d+)?(?:\s?|-)(?:in|inch|inches|cm|mm)\b|\b\d+(?:[.,]\d+)?["”]/gi },
  { kind: "measurement", re: /\b(inseam|rise of|length of)\b/gi },
  { kind: "origin", re: /\b(made in|imported|handmade|hand[- ]made|handcrafted|hand[- ]crafted)\b/gi },
  /* The owner: labels are never mentioned (above all the CARBON JEANS waistband label). */
  /* "patch" alone is often the design ("distressed patches", "faded patches"),
     so only a label-type patch counts: one made of leather/PU/rubber, one
     carrying the brand or logo, or one on the waistband or back. */
  {
    kind: "label",
    re: /\b(labels?|woven tags?|neck tags?|brand tags?|hang ?tags?|(?:leather|leatherette|pu|jacron|rubber|woven|brand(?:ed)?|logo|waistband|back) patch(?:es)?|patch(?:es)? (?:reading|that reads|with the (?:brand|logo)))\b/gi,
  },
  /* Branding ON the waistband is the jeans label in other words ("Carbon logo
     at back waistband", "'CARBON' text on the front waistband"). Same
     sentence, no comma between, within a few words; a plain "drawstring
     waistband" or a logo elsewhere ("skull logo on the thigh") is fine. */
  {
    kind: "label",
    re: /\bwaistband\b[^.,;\n]{0,35}\b(?:logo|text|lettering|branding|wording|reads|reading|embossed)\b|\b(?:logo|text|lettering|branding|wording|embossed)\b[^.,;\n]{0,35}\bwaistband\b/gi,
    label: "branding on the waistband",
  },
  { kind: "logo-shape", re: /\b(hexagon(?:al)?|hexagons|honeycomb|geometric (?:logo|emblem|mark)|abstract (?:logo|emblem|mark))\b/gi },
  { kind: "brand", re: /\bcarbon\s+jeans\b/gi, label: '"Carbon Jeans" as the brand' },
  { kind: "cliche", re: /\b(elevat(?:e|es|ed|ing)|versatil(?:e|ity)|must[- ]have|boasts?|adorn(?:s|ed|ing)?|wardrobe (?:staple|essential)|statement piece|make a statement|trendy|stylish|chic|sleek|timeless|iconic|edgy|vibes?|effortless(?:ly)?|flattering|own the night|add a touch|you'll love|game[- ]changer|look no further|step into|turn heads|perfect (?:for|blend|choice|addition)|standard)\b/gi },
];

const SET_RULE: Rule = {
  kind: "set-contents",
  re: /\b(includes?|including|comes with|sold (?:together|as a set)|two[- ]piece|2[- ]piece|three[- ]piece|3[- ]piece|set of \w+|matching set includes)\b/gi,
};

/** Words of the product name, which are never claims. */
function nameWords(productTitle: string): Set<string> {
  return new Set(
    String(productTitle || "")
      .toLowerCase()
      .split(/[^a-z0-9%]+/)
      .filter(Boolean),
  );
}

export function plainText(html: string): string {
  return String(html || "")
    .replace(/<\s*(br|\/p|\/li|\/h\d)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** Sentences, split on terminal punctuation and line breaks. */
export function sentences(text: string): string[] {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type ClaimContext = {
  productTitle: string;
  isSet?: boolean;
  setPartners?: string[];
  /** Verified composition (purchase orders). A fibre word it contains is a fact, not a claim. */
  fabric?: string;
};

/** Fibre words the verified composition backs ("Upper: Faux Fur" → faux, fur). */
function fabricWords(fabric: string | undefined): Set<string> {
  return new Set(
    String(fabric || "")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 2 && !["upper", "sole", "lining", "shell", "and", "with"].includes(w)),
  );
}

/** Every unsupported claim in a piece of plain text. */
export function findClaims(text: string, ctx: ClaimContext): ClaimFinding[] {
  const own = nameWords(ctx.productTitle);
  const fibres = fabricWords(ctx.fabric);
  /* A faux-fur or fleece item LOOKS plush and thick — that is its design, not a feel claim. */
  const pile = /\b(fur|fleece|sherpa|terry|teddy|plush)\b/i.test(`${ctx.fabric || ""} ${ctx.productTitle}`);
  const rules = ctx.isSet ? [...RULES, SET_RULE] : RULES;
  const out: ClaimFinding[] = [];
  for (const sentence of sentences(text)) {
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      for (const m of sentence.matchAll(rule.re)) {
        const term = m[0];
        const words = term.toLowerCase().split(/[^a-z0-9%]+/).filter(Boolean);
        /* Part of the product's own name → the owner said it, not the model. */
        if (words.length && words.every((w) => own.has(w))) continue;
        /* Backed by the verified fabric: "faux fur slides" when the upper is faux fur. Percentages stay out. */
        if (rule.kind === "material" && !/%/.test(term) && words.length && words.every((w) => fibres.has(w))) continue;
        if (rule.kind === "feel" && pile && /^(plush|thick)$/i.test(term)) continue;
        /* "a relaxed look", "looks oversized": appearance, not a fit promise. */
        if (rule.kind === "fit" && /\blooks?\b/i.test(sentence.slice(Math.max(0, (m.index ?? 0) - 30), (m.index ?? 0) + term.length + 30))) continue;
        out.push({ kind: rule.kind, term: rule.label ?? term, sentence });
      }
    }
  }
  return out;
}

/** Findings for an HTML field. */
export function findClaimsInHtml(html: string, ctx: ClaimContext): ClaimFinding[] {
  return findClaims(plainText(html), ctx);
}

/** True when a sentence contains no unsupported claim. */
function clean(sentence: string, ctx: ClaimContext): boolean {
  return findClaims(sentence, ctx).length === 0;
}

/**
 * Remove every sentence (and every bullet) that carries an unsupported claim.
 *
 * Removing a sentence can only take a claim away, never add one, so this is
 * the deterministic last word after the model has had its chance to rewrite.
 * Elements left empty are dropped; a list left with no items is dropped.
 */
export function stripClaimsFromHtml(html: string, ctx: ClaimContext): string {
  let out = String(html || "");
  /* Bullets: one claim takes the whole bullet. */
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (whole, inner: string) => (clean(plainText(inner), ctx) ? whole : ""));
  /* Paragraphs and headings: drop the offending sentences, keep the rest. */
  out = out.replace(/<(p|h[1-6])\b([^>]*)>([\s\S]*?)<\/\1>/gi, (_w, tag: string, attrs: string, inner: string) => {
    if (/<(ul|ol|li|img)\b/i.test(inner)) return _w;
    const kept = sentences(plainText(inner)).filter((s) => clean(s, ctx));
    return kept.length ? `<${tag}${attrs}>${escapeHtml(kept.join(" "))}</${tag}>` : "";
  });
  out = out.replace(/<(ul|ol)\b[^>]*>\s*<\/\1>/gi, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Plain-text field (meta description, alt text): drop the offending sentences. */
export function stripClaimsFromText(text: string, ctx: ClaimContext): string {
  return sentences(String(text || ""))
    .filter((s) => clean(s, ctx))
    .join(" ")
    .trim();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One line per finding, for the repair prompt and the review panel. */
export function describeFindings(findings: ClaimFinding[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of findings) {
    const key = `${f.kind}:${f.term.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${f.kind}: "${f.term}"`);
  }
  return out;
}

/** The Carbon voice, shared by every prompt that writes product copy. */
export const CARBON_VOICE = [
  "CARBON is a streetwear-led fashion brand for men and women (shopcarbon.com, Orlando FL). Write like CARBON talks:",
  "- Short, confident, specific. Say what it is, how it looks and how to wear it.",
  '- Concrete over hype: "ripped and frayed across the front" beats "edgy distressed detailing".',
  '- Second person sparingly ("Wear them with…"), never "you\'ll love". One idea per sentence. Plain US English. No exclamation marks, no questions.',
  '- The brand is always written "CARBON" (all capitals, owner 2026-10-18) — never "Carbon" and never "Carbon Jeans". The logo is called "the CARBON logo", never described by its shape.',
  '- Open each description with the product itself (its colour, print, cut) — never "<Name> features…" or "The <Name> is a…", and never end on "completes the design/look".',
  "- No clichés: elevate, versatile, must-have, boasts, adorned, wardrobe staple/essential, statement piece, make a statement, trendy, stylish, chic, sleek, timeless, iconic, edgy, vibe, effortless, flattering, perfect for, step into, turn heads, own the night, add a touch, standard.",
].join("\n");

/** The rules every prompt states, matching what findClaims enforces. */
export function claimRulesFor(ctx: ClaimContext): string {
  const fabric = String(ctx.fabric || "").trim();
  const lines = [
    "NEVER STATE (the photos cannot show it and nobody has verified it — such a sentence is deleted):",
    fabric
      ? `  - what it is made of, beyond the VERIFIED fabric "${fabric}": you may name those fibres where a shopper searches them (faux fur slides, linen shirt, satin dress) — never a percentage, never a fibre that is not in it`
      : "  - what it is made of: cotton, polyester, leather, faux, recycled, any fibre or percentage",
    "  - how it feels or performs: soft, stretchy, breathable, lightweight, warm, comfortable, durable, premium quality",
    "  - how it fits: true to size, slim fit, relaxed fit, high-rise (\"a relaxed look\" — describing the look — is fine)",
    "  - measurements, lengths or sizes, care instructions, where it was made",
    "  - the fly type (zip fly, button fly, button and zip) unless exposed buttons or a zip are clearly visible in the photos — it is almost always hidden, and earlier copy got it wrong",
    '  - labels, patches or tags of any kind — never mention the waistband label, a back patch or a brand tag, and never quote the "CARBON JEANS" text printed on them',
    '  - the logo\'s shape: it is "the CARBON logo", and only mention it when it is printed or embroidered as the design',
    "Describe the design instead: colour, wash, print and its wording, graphics, distressing, neckline, sleeves, pockets, closures, hardware, hem, silhouette as it looks.",
  ];
  if (ctx.isSet) {
    lines.push(
      'THIS PAGE SELLS ONE PIECE OF A MATCHING SET. Each piece is sold separately at its own price. You may say it is part of the set and pairs with the matching piece; NEVER say it includes, comes with, or is a two-piece set.',
      ctx.setPartners?.length
        ? `  The matching piece${ctx.setPartners.length > 1 ? "s are" : " is"}: ${ctx.setPartners.map((p) => `"${p}"`).join(", ")}. Write it as "Pair it with the ${ctx.setPartners[0]}." (or "Part of the <set name> set: pair it with the ${ctx.setPartners[0]}.") — that piece is NOT this set, so never write "part of the ${ctx.setPartners[0]}". Call it by a garment type only when its store type below says so; never guess.`
        : "  Do not say what kind of garment the matching piece is — you have not seen it.",
      "  Never put both pieces in the title or the meta description — they describe only this piece.",
    );
  }
  return lines.join("\n");
}
