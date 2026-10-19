/**
 * Carbon Studio LOOK SHEET — everything the model wears that is not the
 * product, decided ONCE per run, in code.
 *
 * The four panels of a run are four separate image calls that never see each
 * other. Whatever their words leave open, each of them settles on its own:
 * "flip-flops, or naturally bare feet" came back as sandals in one panel and
 * bare feet in the next, "a short-sleeve or sleeveless top" as both, and the
 * open-ended "wear the outfit in the item photos" let every panel pick its own
 * pieces out of thirteen photos from different shoots. So the outfit is
 * resolved here, before anything is paid for: every slot named concretely,
 * every "X or Y" decided by a seed, the accessories a closed list. The client
 * builds the sheet once and sends its `text` with every panel; the server puts
 * it, byte for byte, in the protected part of every prompt.
 *
 * Precedence per slot: Style-with photos > a piece the item instruction names
 * outright > the OUTFIT lines read off the item photos > styling the
 * instruction only implies ("style it dressy") > the house defaults. A piece
 * the operator TYPED outranks the photographed one because the operator's
 * words are the final word of every prompt (OPERATOR INSTRUCTION — FINAL
 * WORD); a sheet that said otherwise would put the two in open conflict.
 *
 * The seed is FNV-1a of `${matrixId}|${modelId}|${colour}`, so the same
 * product on the same model in the same colour gets the same look on every
 * run, not only in every panel.
 */
import { stableLsSystemIdFromString } from "@/lib/utils/ls-id";
import { type OutfitSlot, isLightColour, isSwimwearItemType, itemTypeCategory } from "@/lib/panelGeneration";
import { type AccessoryKind, accessoryLookSlots } from "@/lib/accessoryShots";

/** What a styling note in the item instruction asks for, as concrete pieces
 *  (POST /api/openai/look-resolve). */
export type ResolvedStyling = {
  /** One concrete non-product piece per slot the note asks for or clearly implies. */
  slots?: Partial<Record<OutfitSlot, string>>;
  /** A change the note makes to whatever fills a slot ("shirt is oversized" → top: "oversized"). */
  adjust?: Partial<Record<OutfitSlot, string>>;
  /** Slots the note names outright ("black leather trousers") — they outrank the photos' OUTFIT lines. */
  explicit?: OutfitSlot[];
  /** How the top is worn, when the note says so. */
  tuck?: "tucked" | "untucked" | "front-tucked";
};

export type LookSheetInput = {
  itemType: string;
  gender: "male" | "female";
  /** The matrix description; read only when the item type alone says nothing about the garment. */
  productName?: string;
  /** Optional override of the styling category: "top" | "bottom" | "outerwear" | "full-look" |
   *  "footwear" | "accessory" | "item". Inferred from the item type when absent. */
  category?: string;
  /** parseOutfitFromSpec(spec) — the clothes the product was photographed with. */
  specOutfit: Partial<Record<OutfitSlot, string>>;
  /** /api/openai/style-pieces `outfit` — the operator's STYLE-WITH pieces. */
  styleWith?: Partial<Record<OutfitSlot, string>>;
  instructionStyling?: ResolvedStyling | null;
  itemColour?: string;
  /** Set in accessory mode (lib/accessoryShots.ts getAccessoryKind). */
  accessoryKind?: AccessoryKind | null;
  /** `${matrixId}|${modelId}|${colour}`. */
  seedKey: string;
  /** false (the default the Studio offers): a photographed styling piece is worn WITHOUT its
   *  printed text and graphics — at 768×1024 a frame cannot letter a tee's print, and the
   *  pseudo-letters it draws instead are what the catalogue audit kept finding. */
  keepStylingPrints: boolean;
  /** The product is a bottom with a label on its back waistband
   *  (lib/panelGeneration.ts needsBackWaistbandTuck): ONE tucked TOP line for every panel. */
  backWaistbandLabel: boolean;
};

export type LookSheet = {
  version: 1;
  seed: number;
  slots: Record<string, string>;
  text: string;
  /** Where each styling line came from: the instruction, a Style-with photo, the item photos, or the default. */
  sources?: Partial<Record<string, "style" | "instr" | "photo" | "default">>;
};

type LookCategory = "top" | "bottom" | "outerwear" | "full-look" | "footwear" | "accessory" | "item" | "swim";
type Source = "style" | "instr" | "photo" | "default";
type Piece = { text: string; source: Source };

const OUTFIT_SLOTS: OutfitSlot[] = ["top", "top_under", "bottom", "outerwear", "footwear", "accessories"];
const CATEGORY_NAMES = new Set(["top", "bottom", "outerwear", "full-look", "footwear", "accessory", "item"]);

const SHEET_HEADER =
  "LOOK SHEET — everything the model wears that is NOT the product, decided once for this whole shoot: the same pieces, worded the same, in every frame of every panel. A frame that shows no person shows none of it.";

/* ---------- words ---------- */

const NEGATION = /\b(?:no|not|never|without|nothing|none|neither)\b/i;
const ARTICLE = /^(?:a|an|the|one)\b/i;

/**
 * Text written by a model (the photo analysis, the Style-with reader, the
 * instruction resolver) with every "or" settled. A list of things that are
 * absent ("no logo or text") is not a choice and becomes "no logo, nor text";
 * a real alternative keeps its second option, which in this kind of text is
 * the one that still reads as a whole phrase ("black or dark navy chinos" →
 * "dark navy chinos", "a tee or an open shirt in white" → "an open shirt in
 * white"). The house text never contains an "or" in the first place.
 */
export function withoutChoiceWords(value: string): string {
  let s = String(value || "").replace(/\band\/or\b/gi, "and").replace(/\beither\s+/gi, "");
  for (let guard = 0; guard < 12; guard += 1) {
    const m = /\s+or\s+/i.exec(s);
    if (!m) break;
    const left = s.slice(0, m.index);
    const right = s.slice(m.index + m[0].length);
    const clause = left.slice(Math.max(left.lastIndexOf("."), left.lastIndexOf(";"), left.lastIndexOf(":"), left.lastIndexOf("—")) + 1);
    if (NEGATION.test(clause)) {
      s = `${left}, nor ${right}`.replace(/,\s*,/g, ",");
      continue;
    }
    if (ARTICLE.test(right)) {
      const cut = Math.max(left.lastIndexOf(","), left.lastIndexOf(";"), left.lastIndexOf(":"), left.lastIndexOf("—"), left.lastIndexOf("("));
      const head = cut >= 0 ? `${left.slice(0, cut + 1)} ` : "";
      s = `${head}${right}`.replace(/\s{2,}/g, " ");
      continue;
    }
    const lastWord = /(\S+)$/.exec(left);
    s = `${lastWord ? left.slice(0, lastWord.index) : left}${right}`.replace(/\s{2,}/g, " ");
  }
  return s.trim();
}

function clean(v: unknown): string {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim().replace(/[.;,\s]+$/, "") : "";
  return t ? withoutChoiceWords(t) : "";
}

const PATTERN_WORDS =
  /\b(?:leopard|zebra|snake(?:skin)?|animal|floral|flowers?|check(?:ed)?|plaid|gingham|tartan|stripe[sd]?|polka|dots?|camo(?:uflage)?|paisley|tie-?dye|houndstooth|abstract|geometric|marbled?)\b/i;
const QUOTED = /["“][^"”]{2,}["”]|'[A-Z0-9][^']{1,40}'/;
const PRINT_WORDS =
  /\b(?:prints?|printed|graphics?|texts?|lettering|letters|words?|slogans?|logos?|wordmarks?|typography|numbers?|writing|script|emblems?|badges?|artwork|illustrations?|motifs?|decals?)\b/i;
const TEXT_WORDS = /\b(?:texts?|lettering|letters|words?|slogans?|wordmarks?|typography|writing|script)\b/i;

/** A photographed description with its printed text / graphics taken out, so the sheet never
 *  names a print the piece is to be worn without. `textOnly` keeps logos and graphics (shoes). */
function withoutPrints(desc: string, textOnly: boolean): string {
  const hit = (s: string) => (textOnly ? TEXT_WORDS.test(s) || QUOTED.test(s) : PRINT_WORDS.test(s) || QUOTED.test(s));
  const keep = (s: string) => !hit(s) || (PATTERN_WORDS.test(s) && !TEXT_WORDS.test(s) && !QUOTED.test(s));
  const noWith = desc.replace(/\s+(?:with|featuring|bearing|showing)\s+([^,;—]*)/gi, (m, phrase: string) => (keep(phrase) ? m : ""));
  return noWith
    .split(/\s*[,;]\s*|\s+—\s+/)
    .filter((c) => c && keep(c))
    .join(", ")
    .trim();
}

/* A fit word on its own ("relaxed straight-leg", "slim-fit") — never the first half of a
   compound like "wide-leg" or "skinny-leg", which names the cut, not the fit. */
const FIT_WORDS = /\b(?:oversized|boxy|baggy|relaxed|regular|slim|skinny|loose|fitted|tight|tapered|longline)(?:[\s-]+fit(?:ting)?)?(?![\w-]),?\s*/gi;

/* The cut of a leg, which a fit adjustment ("skinny", "wide") replaces too. */
const CUT_WORDS = /\b(?:wide|straight|flared?|boot ?cut|tapered|skinny|slim|baggy|barrel|balloon)[\s-]+leg(?:ged)?\b,?\s*|\b(?:bootcut|flared?)\b,?\s*/gi;
const FIT_OR_CUT = /\b(?:oversized|boxy|baggy|relaxed|regular|slim|skinny|loose|fitted|tight|tapered|longline|wide|straight|flared?|bootcut|barrel|balloon)\b/i;

/** "an heavyweight tee" → "a heavyweight tee" once a fit word in front has gone. */
function fixArticles(s: string): string {
  return s.replace(/\b([Aa])n?\s+(?=(\S))/g, (_m, a: string, next: string) => `${a}${/^[aeiou]/i.test(next) ? "n" : ""} `);
}

/* ---------- category ---------- */

function categoryOf(text: string): LookCategory {
  const t = String(text || "").toLowerCase();
  if (isSwimwearItemType(t)) return "swim";
  /* Worn as a top, named like nothing: the default tee went OVER a bodysuit
     (Cindy Bodysuit, a white crop tee on top of the product). */
  if (/\b(?:body ?suits?|leotards?|bustiers?|bralettes?|bra tops?|camis?|camisoles?|tube tops?)\b/.test(t)) return "top";
  if (/\b(?:catsuits?|unitards?)\b/.test(t)) return "full-look";
  if (/\bskorts?\b/.test(t)) return "bottom";
  return itemTypeCategory(t) as LookCategory;
}

function lookCategory(input: LookSheetInput): LookCategory {
  const override = String(input.category || "").trim().toLowerCase();
  if (CATEGORY_NAMES.has(override)) return isSwimwearItemType(input.itemType) ? "swim" : (override as LookCategory);
  const fromType = categoryOf(input.itemType);
  if (fromType !== "item" || !input.productName) return fromType;
  return categoryOf(input.productName);
}

/** The slots the product itself fills — a photographed or chosen piece there is ignored. */
function productSlots(cat: LookCategory, female: boolean, itemType: string): Set<string> {
  switch (cat) {
    case "top":
      return new Set(["top"]);
    case "outerwear":
      return new Set(["outerwear"]);
    case "bottom":
      return new Set(["bottom"]);
    case "full-look":
      return new Set(["top", "bottom"]);
    case "footwear":
      return new Set(["footwear"]);
    case "swim":
      /* A swimsuit or bikini is the whole look; men's swim shorts keep today's tee. */
      return female || itemTypeCategory(itemType) !== "bottom" ? new Set(["top", "bottom"]) : new Set(["bottom"]);
    default:
      return new Set();
  }
}

/* ---------- the sheet ---------- */

function pick<T>(seed: number, salt: number, options: T[]): T {
  return options[Math.abs(seed + salt) % options.length];
}

/** A description cut back to whole clauses (then whole words) within `max` characters. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const atClause = head.lastIndexOf(", ");
  const cut = atClause > max * 0.5 ? head.slice(0, atClause) : head.slice(0, Math.max(head.lastIndexOf(" "), 1));
  return cut.replace(/(?:\s+(?:and|with|in|on|at|of|the|a|an))+\s*$/i, "").replace(/[\s,;:—-]+$/, "");
}

function pieceFor(slot: OutfitSlot, input: LookSheetInput, maxDesc: number): Piece | null {
  const take = (v: unknown) => clip(clean(v), maxDesc);
  const st = input.instructionStyling;
  const fromInstr = take(st?.slots?.[slot]);
  /* Owner 2026-10-19: a piece the item instruction NAMES ("white sneakers")
     wins over the Style-with photo and the item photos. Before, a Style-with
     photo's shoes beat it, so the sheet said one pair and the instruction —
     which every panel also reads — another, and separately rendered panels
     split between the two (Jesus Cargo Pants, Pablo Pants). */
  if (fromInstr && st?.explicit?.includes(slot)) return { text: fromInstr, source: "instr" };
  const style = take(input.styleWith?.[slot]);
  if (style) return { text: style, source: "style" };
  const photo = take(input.specOutfit?.[slot]);
  if (photo) return { text: photo, source: "photo" };
  if (fromInstr) return { text: fromInstr, source: "instr" };
  return null;
}

const APPAREL_SLOTS = new Set(["top", "top_under", "bottom", "outerwear"]);
const REFERS_TO_PHOTOS = /\b(?:item photos?|the photos?|photographed|style-with)\b/i;

const TUCK_WORDS = /\b(?:tucked|untucked|tuck|front[- ]tuck(?:ed)?|half[- ]tuck(?:ed)?|french tuck)\b/i;

/** One slot's line, from where its piece came from. `tuck` (top only) is the one tuck state
 *  the sheet imposes; a tuck word in the photographed description would contradict it. */
function renderPiece(
  slot: string,
  piece: Piece,
  input: LookSheetInput,
  opts?: { tuck?: string | null; pairingExtra?: boolean },
): string {
  const adjust = clean(input.instructionStyling?.adjust?.[slot as OutfitSlot]);
  const refit = Boolean(adjust && FIT_OR_CUT.test(adjust));
  const keepPrints = input.keepStylingPrints === true;
  const apparel = APPAREL_SLOTS.has(slot);
  const textOnly = slot === "footwear";
  const photographed = piece.source === "style" || piece.source === "photo" || (piece.source === "instr" && REFERS_TO_PHOTOS.test(piece.text));
  const stripPrints = photographed && !keepPrints && (apparel || textOnly);
  let desc = stripPrints ? withoutPrints(piece.text, textOnly) || piece.text : piece.text;
  if (refit) {
    desc = fixArticles(desc.replace(CUT_WORDS, "").replace(FIT_WORDS, "").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, ""));
  }
  if (opts?.tuck) {
    desc =
      desc
        .split(/\s*[,;]\s*/)
        .filter((c) => c && !TUCK_WORDS.test(c))
        .join(", ") || desc;
  }
  const same = slot === "footwear" ? ["colour", "shape", "sole", "laces"] : ["colour", "cut", ...(refit ? [] : ["fit"]), "length", "fabric"];
  const sameList = `same ${same.slice(0, -1).join(", ")} and ${same[same.length - 1]}`;
  const prints = !photographed
    ? ""
    : keepPrints
      ? "; every print, graphic and text copied FROM THE PHOTO at its size, position and lettering, each logo only where the photos show it; a side the photos do not show stays plain"
      : textOnly
        ? "; any lettering on it is left off, each logo sits only where the photos show it, and a side the photos do not show stays plain"
        : apparel
          ? ", but WITHOUT its printed text, graphics and logos — plain cloth where the photo shows them"
          : "";
  const origin =
    piece.source === "style"
      ? ` — the exact piece in the STYLE-WITH photos, worn in every frame: ${sameList}${prints}`
      : piece.source === "photo"
        ? ` — exactly as worn in the item photos: ${sameList}${prints}`
        : piece.source === "instr"
          ? ` — as the item instruction asks${photographed ? `: ${sameList}${prints}` : ""}`
          : "";
  const adjusted = adjust ? `; ${adjust}, as the item instruction says` : "";
  if (slot === "accessories") {
    const where = piece.source === "photo" ? " (as worn in the item photos)" : piece.source === "style" ? " (the pieces in the STYLE-WITH photos)" : "";
    return opts?.pairingExtra
      ? `${desc}${where} — exactly these, plus only the one extra piece the PAIRING shot names`
      : `${desc}${where} — exactly these and nothing else: no other jewellery, watch, belt, hat, sunglasses, bag`;
  }
  return `${desc}${origin}${adjusted}${opts?.tuck ? `; ${opts.tuck}` : ""}`;
}

function tuckOf(st: ResolvedStyling | null | undefined): string | null {
  if (st?.tuck === "tucked") return "worn tucked in";
  if (st?.tuck === "untucked") return "worn untucked";
  if (st?.tuck === "front-tucked") return "worn front-tucked, the back hem left out";
  return null;
}

type SheetLine = { slot: string; label: string; text: string; source?: Source };

const HAIR_DEFAULT =
  "the model's own hair, styled exactly as in the first MODEL reference image — the same length, parting and styling in every frame, kept clear of the neckline, the prints and the product";

/** Garment mode: the slots for this category, defaults filling what no source names. */
function garmentLines(input: LookSheetInput, seed: number, maxDesc: number): { lines: SheetLine[]; tuck: string | null } {
  const female = String(input.gender || "").trim().toLowerCase() === "female";
  const cat = lookCategory(input);
  const swim = cat === "swim";
  const occupied = productSlots(cat, female, input.itemType);
  const light = isLightColour(input.itemColour ?? "");
  const tee = light ? "washed black" : "off-white";
  const denim = light ? "mid-blue" : "light-blue";
  const noPrint = "no print, no logo, no pocket, no graphic";

  const defaults: Partial<Record<OutfitSlot, string>> = {
    top:
      cat === "bottom" || cat === "footwear" || cat === "accessory" || cat === "item" || (swim && !occupied.has("top"))
        ? female
          ? `a slightly cropped boxy heavyweight cotton t-shirt in ${tee}, short sleeves, ribbed crew neck, dropped shoulders — ${noPrint}`
          : `an oversized boxy heavyweight cotton t-shirt in ${tee}, short sleeves, ribbed crew neck, dropped shoulders — ${noPrint}`
        : undefined,
    top_under:
      cat === "outerwear" ? `a plain fitted ribbed crew-neck tee in ${light ? "black" : "white"}, short sleeves — no print, no logo; worn untucked` : undefined,
    bottom:
      cat === "top" || cat === "outerwear" || cat === "footwear" || cat === "accessory"
        ? female
          ? `high-waisted wide-leg ${denim} washed denim jeans, full length, clean hem — no rips, no visible logo`
          : `relaxed straight-leg ${denim} washed denim jeans, full length with a slight stack at the ankle — no rips, no visible logo`
        : undefined,
    footwear: swim
      ? pick(seed, 1, [
          "plain black rubber flip-flops with a thin black thong strap and a flat black sole — the same pair in every frame, both feet identical",
          "none — naturally bare feet in every frame",
        ])
      : "the shoes the item photos show the model wearing, exactly as photographed; when no photo shows shoes: chunky white leather low-top sneakers with a thick plain white rubber sole, flat white laces, no visible branding, no contrast panels — the exact same pair in every frame, both feet identical",
  };
  const resolved: Partial<Record<OutfitSlot, Piece>> = {};
  for (const slot of OUTFIT_SLOTS) {
    if (occupied.has(slot)) continue;
    const p = pieceFor(slot, input, maxDesc);
    if (p) resolved[slot] = p;
    else if (defaults[slot]) resolved[slot] = { text: defaults[slot]!, source: "default" };
  }

  const lines: SheetLine[] = [];
  const put = (slot: string, label: string, text: string, source?: Source) => lines.push({ slot, label, text, source });
  const instrTuck = tuckOf(input.instructionStyling);
  let tuck: string | null = null;
  const top = resolved.top;
  if (top) {
    /* Owner rules (2026-10-14): the top is ALWAYS over the pants / shorts, in
       every frame; only the label pose (male Pose 7) lifts the back hem, just
       enough to show a back-waistband label — Pose 4 keeps the top over it.
       Never bare skin between top and waistband; a close-up may raise the hem
       a little — to the waistband's top edge, never past it ("just clear of
       it" read as a gap and showed the lower back, Julian Jeans 2026-10-14). The carve-outs sit inside this one line, so every panel reads
       the same words. The item instruction's own word on tucking still wins. */
    const labelPose = !female && input.backWaistbandLabel ? 7 : null;
    const over =
      top.source === "default" && female
        ? "worn untucked over the waistband in every frame, the slightly cropped hem ending at the waistband"
        : "worn untucked over the waistband in every frame, the hem hanging straight over it";
    tuck =
      instrTuck ??
      `${over}${
        labelPose
          ? ` — except in Pose ${labelPose}, the zoomed-in back crop, where only the back hem is lifted to the top edge of the waistband and rests on it, so the label below that edge shows in full (the full-body back view keeps the top over it)`
          : ""
      }; it always covers the stomach and the lower back — no skin shows between the top and the waistband in any frame, even where the item photos show a bare back; a close-up of the waistband may raise the hem a little, only up to the waistband's top edge, where it rests — never above it`;
    put("top", "TOP", renderPiece("top", top, input, { tuck }), top.source);
  }
  if (resolved.top_under) put("top_under", "TOP UNDERNEATH", renderPiece("top_under", resolved.top_under, input), resolved.top_under.source);
  if (resolved.bottom) put("bottom", "BOTTOM", renderPiece("bottom", resolved.bottom, input), resolved.bottom.source);
  if (!occupied.has("outerwear")) {
    put(
      "outerwear",
      "OUTERWEAR",
      resolved.outerwear
        ? renderPiece("outerwear", resolved.outerwear, input)
        : `none — nothing is worn over the ${cat === "top" || cat === "full-look" || swim ? "product" : "top"}`,
      resolved.outerwear?.source ?? "default",
    );
  }
  const shoes = resolved.footwear;
  if (shoes) {
    put("footwear", "FOOTWEAR", renderPiece("footwear", shoes, input), shoes.source);
    put(
      "socks",
      "SOCKS",
      /^(?:none|bare|barefoot)\b/i.test(shoes.text) || /\b(?:flip-?flops?|sandals?|slides?)\b/i.test(shoes.text)
        ? "none"
        : shoes.source === "default"
          ? "plain white no-show socks, never visible above the shoe"
          : "none visible above the shoe",
    );
  }
  put(
    "accessories",
    "ACCESSORIES",
    resolved.accessories
      ? renderPiece("accessories", resolved.accessories, input)
      : cat === "accessory"
        ? "nothing besides the product — no watch, no jewellery, no belt, no hat, no sunglasses, no bag"
        : "exactly the accessories the item photos show the model wearing (bracelets, rings, a watch), the same pieces in the same places in every frame, and nothing else — none when the photos show none",
  );
  put("hair", "HAIR", HAIR_DEFAULT);
  /* The product's own hem, when it is a top: tucked in one panel and loose in
     the next reads as two different garments. A bodysuit has no loose hem. */
  if (cat === "top" && !/\b(?:body ?suits?|leotards?)\b/i.test(`${input.itemType} ${input.productName ?? ""}`)) {
    /* Owner rule: a shirt is always worn over the pants / shorts. */
    tuck = instrTuck ?? "worn untucked — its hem falls over the waistband at its own length";
    put("tuck", "TUCK", `the product is ${tuck}, in every frame`);
  }
  return { lines, tuck };
}

/** Accessory mode: the kind's resolved outfit, a source piece replacing the default for its slot. */
function accessoryLines(
  input: LookSheetInput,
  kind: AccessoryKind,
  seed: number,
  maxDesc: number,
): { lines: SheetLine[]; tuck: string | null } {
  const defaults = new Map(accessoryLookSlots(kind, input.gender, input.itemColour ?? "", seed).map((d) => [d.slot, d]));
  const order = ["top", "top_under", "bottom", "outerwear", "footwear", "hands", "face", "hair", "strap", "accessories"];
  const labels: Record<string, string> = { top_under: "TOP UNDERNEATH" };
  const tuck = tuckOf(input.instructionStyling);
  const lines: SheetLine[] = [];
  for (const slot of order) {
    const piece = (OUTFIT_SLOTS as string[]).includes(slot) ? pieceFor(slot as OutfitSlot, input, maxDesc) : null;
    const d = defaults.get(slot);
    const slotTuck = slot === "top" ? tuck : null;
    if (piece) {
      lines.push({
        slot,
        label: labels[slot] ?? slot.toUpperCase(),
        text: renderPiece(slot, piece, input, { tuck: slotTuck, pairingExtra: true }),
        source: piece.source,
      });
    } else if (d) {
      lines.push({
        slot,
        label: d.label,
        // The kind's own accessories line already names the PAIRING exception.
        text: slot === "accessories" ? d.text : renderPiece(slot, { text: d.text, source: "default" }, input, { tuck: slotTuck }),
        source: "default",
      });
    }
  }
  if (!defaults.has("hair")) lines.push({ slot: "hair", label: "HAIR", text: HAIR_DEFAULT });
  return { lines, tuck };
}

/** UTF-8 bytes the sheet stays within. /api/generate refuses a sheet over 3,000 bytes rather
 *  than trim it, so the sheet makes room itself by shortening the longest photographed
 *  descriptions — a Style-with reading may run to 500 characters per piece. */
export const LOOK_SHEET_BUDGET_BYTES = 2800;
const DESC_STEPS = [Number.POSITIVE_INFINITY, 320, 240, 180, 130, 90];

/** The run's look, resolved in code. Same input → byte-identical text. */
export function resolveLookSheet(input: LookSheetInput): LookSheet {
  const seed = stableLsSystemIdFromString(String(input.seedKey || ""));
  let built: { lines: SheetLine[]; tuck: string | null; text: string } | null = null;
  for (const maxDesc of DESC_STEPS) {
    const r = input.accessoryKind ? accessoryLines(input, input.accessoryKind, seed, maxDesc) : garmentLines(input, seed, maxDesc);
    const text = [SHEET_HEADER, ...r.lines.map((l) => `- ${l.label}: ${l.text}.`)].join("\n");
    built = { ...r, text };
    if (new TextEncoder().encode(text).length <= LOOK_SHEET_BUDGET_BYTES) break;
  }
  const { lines, tuck, text } = built!;
  const slots: Record<string, string> = {};
  const sources: NonNullable<LookSheet["sources"]> = {};
  for (const l of lines) {
    slots[l.slot] = l.text;
    if (l.source) sources[l.slot] = l.source;
  }
  if (tuck && !slots.tuck) slots.tuck = tuck;
  return { version: 1, seed, slots, text, sources };
}

/* Words that mean the item instruction talks about what is worn WITH the
   product — only then is the styling resolver called (a cent, ~1-2 s). A
   false positive costs one cheap call that answers "no styling"; a miss
   leaves the styling to the FINAL WORD line, as before. */
const STYLING_WORDS =
  /\b(?:style[ds]?|styling|outfit|look|wear(?:s|ing)?|worn|pair(?:ed|ing)?|match(?:ing|ed)?|dress(?:y|ed)?|casual|formal|smart|street(?:wear)?|chic|elegant|classy|sporty|edgy|layer(?:ed|ing)?|tuck(?:ed)?|untuck(?:ed)?|barefoot|sneakers?|trainers?|shoes?|heels?|boots?|sandals?|loafers?|slides?|flip-?flops?|jeans?|trousers?|pants|shorts|skirt|leggings?|joggers?|shirt|tee|t-?shirt|tshirt|tank|top|blouse|hoodie|sweater|jacket|blazer|coat|vest|belt|bag|watch|jewel(?:le)?ry|necklace|bracelet|chain|rings?|earrings?|hat|cap|beanie|sunglasses|socks?|skin)\b/i;

export function instructionHasStyling(instruction: string): boolean {
  return STYLING_WORDS.test(String(instruction || ""));
}

const SHOE_WORDS = /\b(?:sneakers?|trainers?|shoes?|heels?|boots?|sandals?|loafers?|slides?|flip-?flops?|high-?tops?|low-?tops?|mules?|clogs?|espadrilles?|barefoot)\b/i;
const OTHER_GARMENT =
  /\b(?:shirt|tee|t-?shirt|tshirt|tank|top|blouse|hoodie|sweater|turtleneck|jumper|cardigan|jacket|blazer|coat|vest|jeans?|trousers?|pants|shorts|skirt|leggings?|joggers?|belt|bag|watch|necklace|bracelet|hat|cap|beanie|sunglasses)\b/i;

/**
 * The shoes an item instruction names, in its own words — "white sneakers"
 * from "oversized shirt white and white sneakers"; "all-black high-top
 * sneakers — black upper, black laces, black sole, no white anywhere" from a
 * longer note. null when the note names no shoes, or only says which shoes
 * NOT to wear. Parentheses are dropped (asides like "(not the pair in the
 * Style-with photo)").
 */
export function footwearFromNote(note: string): string | null {
  const text = String(note || "").replace(/\([^)]*\)/g, " ");
  for (const sentence of text.split(/[.;\n!]+/)) {
    if (!SHOE_WORDS.test(sentence)) continue;
    const body = sentence.replace(/^[^:]{0,40}:\s*/, "").trim();
    const parts = body.split(/\s+(?:and|plus|with)\s+|,\s*/).map((p) => p.trim()).filter(Boolean);
    /* "no sneakers, barefoot only" → "barefoot only": a part that says what NOT to wear is skipped. */
    const at = parts.findIndex((p) => SHOE_WORDS.test(p) && !/^(?:no|not|without|never)\b/i.test(p));
    if (at < 0) continue;
    const kept: string[] = [];
    for (const p of parts.slice(at)) {
      if (kept.length && OTHER_GARMENT.test(p) && !SHOE_WORDS.test(p)) break;
      kept.push(p);
    }
    const phrase = kept.join(", ").replace(/\s{2,}/g, " ").trim().slice(0, 240);
    if (phrase) return phrase;
  }
  return null;
}

/**
 * Backstop for the styling reader: when the note names shoes and the reader
 * returned none (it read "oversized shirt white and white sneakers" as a shirt
 * only — Jesus Cargo Pants 2026-10-19), the note's own shoe words become the
 * named footwear piece, so the sheet and the instruction can no longer disagree.
 */
export function withNoteFootwear(styling: ResolvedStyling | null, note: string): ResolvedStyling | null {
  if (styling?.explicit?.includes("footwear") && styling.slots?.footwear) return styling;
  const shoes = footwearFromNote(note);
  if (!shoes) return styling;
  return {
    ...(styling ?? {}),
    slots: { ...(styling?.slots ?? {}), footwear: shoes },
    explicit: [...new Set([...(styling?.explicit ?? []), "footwear" as OutfitSlot])],
  };
}

const NOTE_SLOT_WORDS: Partial<Record<OutfitSlot, RegExp>> = {
  top: /\b(?:shirt|tee|t-?shirt|tshirt|tank|blouse|hoodie|sweater|turtleneck|jumper|cardigan|polo)\b/i,
  outerwear: /\b(?:jacket|blazer|coat|overcoat|parka|bomber)\b/i,
  footwear: SHOE_WORDS,
};
const SOURCE_WORDS: Record<string, string> = { style: "the Style-with photo", photo: "the item photos", default: "the Studio's default outfit" };

/**
 * The pieces the note names that the sheet still takes from somewhere else —
 * a run with one would be told two different things. Shown in the Studio and
 * checked before anything is generated or queued (owner 2026-10-19).
 */
const COLOUR_WORDS =
  /\b(?:black|white|grey|gray|charcoal|silver|gold|blue|navy|denim|indigo|red|burgundy|maroon|pink|purple|lilac|green|olive|khaki|teal|turquoise|yellow|mustard|orange|brown|tan|beige|cream|ivory|nude|camel|taupe|stone|sand|coral)\b/gi;
/** Colour words of a phrase, leaving out the ones it says NOT to use ("no white anywhere"). */
function coloursOf(phrase: string): Set<string> {
  const kept = phrase.replace(/\b(?:no|not|without|never)\s+(?:\w+[\s-]+){0,2}?\w+/gi, " ");
  return new Set([...kept.matchAll(COLOUR_WORDS)].map((m) => m[0].toLowerCase().replace("gray", "grey")));
}

/** The note's own words for one slot: the clause that names the garment. */
function notePhraseFor(slot: OutfitSlot, note: string, re: RegExp): string | null {
  if (slot === "footwear") return footwearFromNote(note);
  for (const sentence of note.split(/[.;\n!]+/)) {
    for (const part of sentence.split(/\s+(?:and|plus)\s+|,\s*/)) {
      if (re.test(part) && !/^\s*(?:no|not|without|never)\b/i.test(part)) return part.trim();
    }
  }
  return null;
}

export function lookConflicts(note: string, sheet: LookSheet): string[] {
  const text = String(note || "").replace(/\([^)]*\)/g, " ");
  const out: string[] = [];
  for (const [slot, re] of Object.entries(NOTE_SLOT_WORDS) as [OutfitSlot, RegExp][]) {
    const src = sheet.sources?.[slot];
    if (!src || src === "instr") continue;
    const phrase = notePhraseFor(slot, text, re);
    if (!phrase) continue;
    const line = String(sheet.slots[slot] || "").split(" — ")[0];
    const noun = re.exec(phrase)?.[0]?.toLowerCase() ?? "";
    /* Agreement: the sheet names the same garment in the same colours ("grey
       turtleneck" vs "dark grey turtleneck sweater"). "white sneakers" vs
       "black and white sneakers" is a conflict. */
    const want = coloursOf(phrase);
    const have = coloursOf(line);
    const sameColours = !want.size || (want.size === have.size && [...want].every((c) => have.has(c)));
    const sameGarment = !noun || line.toLowerCase().includes(noun.replace(/s$/, ""));
    if (sameColours && sameGarment) continue;
    out.push(`Your instruction says "${phrase}", but the look sheet takes the ${slot} from ${SOURCE_WORDS[src] ?? src}: ${line.slice(0, 110)}.`);
  }
  return out;
}
