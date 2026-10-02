/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI from "openai";
import { desiredHandle } from "./handle";
import { withTimeout, parseJsonObjectFromText, asStringArray } from "@/lib/seo/aiText";
import { scoreAll, stripHtml } from "@/lib/seo/deterministic";
import type { ProductContext, SeoFields, SeoFieldKey, Scorecard } from "@/lib/seo/types";
import { SEO_LIMITS } from "@/lib/seo/types";
import { fetchRemoteImageBytes, normalizeRemoteImageUrl, getImageFetchTimeoutMs } from "@/lib/remoteImage";
import { stripSetBanner } from "@/lib/seo/setNotice";

/**
 * The SEO optimizer, extracted from app/api/shopify/seo/optimize so it can run
 * outside a request.
 *
 * It was previously inlined in the route handler, which meant the only way to
 * optimize a product was one HTTP call at a time from the Matrix SEO tab. The
 * bulk catalog pass needs the exact same generation, repair and clamp
 * behaviour — reimplementing it would guarantee the two drift and the bulk
 * result would stop matching what the tab shows. The route is now a thin
 * wrapper around this.
 */

const MODEL = (process.env.SEO_MODEL || "gpt-4o").trim() || "gpt-4o";
const TIMEOUT_MS = Math.max(20000, Math.min(Number(process.env.SEO_TIMEOUT_MS) || 90000, 150000));
/* Raised from 6 now that the first few are high-detail: the tail of the list is
   what carries photos still missing alt text. */
const MAX_VISION_IMAGES = Math.max(1, Math.min(Number(process.env.SEO_MAX_IMAGES) || 8, 10));
/* The first photos (hero, then the next by position) go in at high detail so
   text, logos, stitching and hardware are actually legible; "auto" let OpenAI
   downsample every photo to ~512 px, which is why descriptions could only ever
   talk about silhouette and colour. */
const HIGH_DETAIL_IMAGES = Math.max(1, Math.min(Number(process.env.SEO_HIGH_DETAIL_IMAGES) || 3, 6));
const PREVIOUS_DESCRIPTION_MAX = 1500;
const VERIFIED_FACTS_MAX = 2500;

/**
 * The fields whose text makes claims about the product itself.
 *
 * In photos mode these are rewritten from the photos on every run, whatever
 * they score — a description can score 100 and still describe a different
 * garment, and that is exactly the failure this mode exists to catch. The
 * other fields (seoTitle, tags) keep the score-driven behaviour so opening
 * the tab on an unchanged product does not churn them.
 */
const CLAIM_FIELDS: SeoFieldKey[] = ["bodyHtml", "metaDescription"];

/**
 * The Studio's item spec is a LOCK LIST for the image generator, not a fact
 * sheet about the garment. It carries instructions ("Reproduce verbatim —
 * never paraphrase", "do not add rips, fading, or whiskering") and statements
 * about the reference photography rather than the product ("BACK: not
 * photographed", "NOT CLEARLY VISIBLE (do not invent): …").
 *
 * Handed to a copywriter as verified truth, those turn into claims: a hoodie
 * whose Studio refs had no back shot would be described as having a plain
 * back even when the Shopify photos show a back print — the invented-attribute
 * failure this whole change exists to remove. Keep the observations, drop the
 * instructions.
 */
export function factsFromStudioSpec(lockText: string, maxBytes = VERIFIED_FACTS_MAX): string {
  const kept: string[] = [];
  for (const raw of String(lockText || "").split("\n")) {
    const line = raw.replace(/^\s*\d+\.\s*/, "").trim();
    if (!line) continue;
    /* Statements about the photography, not about the garment. */
    if (/^BACK:\s*not photographed/i.test(line)) continue;
    if (/^NOT CLEARLY VISIBLE/i.test(line)) continue;
    /* What the product was photographed WITH, not the product. */
    if (/^OUTFIT\b/i.test(line)) continue;
    /* Directives aimed at the image model; the observation is what precedes them. */
    const v = line
      .replace(/\s*Reproduce verbatim[\s\S]*$/i, ".")
      .replace(/\s*[-—]\s*(?:same|exact)\b[^.]*\.?\s*$/i, ".")
      .replace(/[;,]?\s*(?:never|do not|don't)\s+(?:invent|add|paraphrase|move|resize|recolou?r)[\s\S]*$/i, ".")
      .replace(/[;,]?\s*no more,?\s*no less\.?\s*$/i, ".")
      .replace(/[\s;,:—-]+\.$/, ".")
      .replace(/\.{2,}$/, ".")
      .trim();
    if (!v || v === "." || v.length < 4) continue;
    kept.push(v);
  }
  /* Truncate on a line boundary — half a line reads as a fact with its
     qualifier cut off. */
  const out: string[] = [];
  let bytes = 0;
  for (const l of kept) {
    bytes += Buffer.byteLength(l, "utf8") + 1;
    if (bytes > maxBytes) break;
    out.push(l);
  }
  return out.join("\n");
}

/**
 * How much of a candidate description is lifted word-for-word from the old one.
 *
 * Handing the model the previous description anchors it: on a live product it
 * read all seven photos, listed "open back with long tie detail" under
 * observed — a detail the old copy never mentioned — and then returned that
 * old copy verbatim anyway. Asking nicely is not a guarantee, so the overlap
 * is measured and a lazy answer is rejected.
 */
export function reusedFraction(candidate: string, previous: string, n = 8): number {
  const words = (s: string) =>
    String(s || "")
      .replace(/<[^>]+>/g, " ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const a = words(candidate);
  const b = words(previous);
  if (a.length < n || b.length < n) return 0;
  const shingles = (w: string[]) => {
    const set = new Set<string>();
    for (let i = 0; i + n <= w.length; i += 1) set.add(w.slice(i, i + n).join(" "));
    return set;
  };
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size) return 0;
  let hit = 0;
  for (const s of A) if (B.has(s)) hit += 1;
  return hit / A.size;
}

/** Above this, the "new" description is the old one wearing a hat. */
const MAX_REUSED_FRACTION = 0.3;

/** Model-returned "observed" entries, which may arrive as objects. */
function asObservedList(value: unknown, max = 20): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    let s = "";
    if (typeof v === "string") s = v;
    else if (v && typeof v === "object") {
      s = Object.values(v as Record<string, unknown>)
        .map((x) => (typeof x === "string" ? x : x == null ? "" : String(x)))
        .filter(Boolean)
        .join(" — ");
    }
    s = s.replace(/\s+/g, " ").trim().slice(0, 160);
    if (s) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
const TARGET_SCORE = 100;
const OVERALL_TARGET = Math.max(80, Math.min(Number(process.env.SEO_OVERALL_TARGET) || 98, 100));
const MAX_REPAIRS = 3;
const MAX_REGEN = 2;

const GEN_FIELDS: SeoFieldKey[] = ["seoTitle", "metaDescription", "bodyHtml", "tags"];

const SCHEMA = `{
  "focusKeyword": string,
  "secondaryKeywords": string[],
  "observed": string[],
  "proposed": {
    "seoTitle": string,
    "metaDescription": string,
    "bodyHtml": string,
    "tags": string[]
  },
  "imageAlts": [ { "id": string, "alt": string } ],
  "rationale": { "seoTitle": string, "metaDescription": string, "bodyHtml": string, "tags": string }
}`;

type GenExtras = {
  /** The description currently on Shopify, as plain text — reference only. */
  previousDescription: string;
  /** Close-up notes distilled from the Studio's item spec, when it has one. */
  verifiedFacts: string;
};

function buildGenInstruction(
  context: ProductContext,
  fieldsToGenerate: SeoFieldKey[],
  useVision: boolean,
  altImageIds: string[],
  extras: GenExtras,
) {
  const colors = (context.colors || []).join(", ") || "(not specified)";
  return [
    "You are a senior e-commerce SEO strategist and apparel product-photo analyst.",
    "",
    "Generate SEO from these inputs:",
    `  • Product name: "${context.title}"`,
    `  • Color(s): ${colors}`,
    useVision
      ? "  • The product PHOTOS provided in this message — the SOURCE OF TRUTH for every claim about the item. The first photos are attached at full detail: read printed text and logos letter by letter, count pockets and buttons, look at seams, hardware, hems, fabric texture."
      : "  • (No photos provided — use the name and color only.)",
    ...(context.productType ? [`  • Product type: ${context.productType}`] : []),
    ...(extras.verifiedFacts
      ? [
          "  • CLOSE-UP NOTES, recorded earlier from this item's own detail photos. Use them to fill in what the product photos above cannot resolve — the exact wording of a print, small hardware, stitching. THE PHOTOS WIN on any conflict: if a note disagrees with what you can see, believe your eyes and ignore the note. A note is not evidence that something is absent:",
          extras.verifiedFacts
            .split("\n")
            .map((l) => `      ${l}`)
            .join("\n"),
        ]
      : []),
    ...(extras.previousDescription
      ? [
          "  • PREVIOUS DESCRIPTION — NOT something to copy. It is here only so you can rescue non-visual details from it. It may describe a different garment entirely:",
          `      "${extras.previousDescription}"`,
        ]
      : []),
    "",
    useVision
      ? 'FIRST fill "observed": 8-15 short facts you can actually SEE in the photos — garment type, fabric look, fit/silhouette, neckline or collar, sleeves, closures, pockets, prints/text/logos with their exact wording and placement, hardware, hem, colour. Then write every field FROM that list plus the name, colour and the close-up notes. If you cannot see something, leave it out — a shorter, true description beats a fuller invented one.'
      : 'Leave "observed" empty.',
    ...(extras.previousDescription
      ? [
          "",
          "HOW TO USE THE PREVIOUS DESCRIPTION:",
          "  - WRITE THE DESCRIPTION FRESH, from your own \"observed\" list. Do NOT reproduce the previous description, and do NOT reuse its sentences or phrases — if a draft of yours repeats a run of words from it, rewrite that part in your own words from what you can see. Returning the previous text back is a failed answer, however good it reads.",
          "  - It is there to be CORRECTED and IMPROVED: say what the photos show that it misses, and drop what it claims that they do not show.",
          "  - Anything a photo CAN show (fabric look, fit, neckline, sleeves, closures, pockets, prints, logos, hardware, hem, colour) must come from the photos. Never keep an old visual claim the photos do not support.",
          "  - Anything a photo can NEVER show (fibre composition, fabric weight, care instructions, country of origin, measurements, the model's height and size worn) may be carried over as-is, unless the photos contradict it — that detail is worth keeping.",
          '  - For every such carried-over detail add one entry to "observed" written as "from previous description: …" so it can be checked.',
        ]
      : []),
    "",
    "Do NOT change or output the product title or the URL handle — they are fixed.",
    fieldsToGenerate.length
      ? `Generate ONLY these "proposed" fields (omit all others): ${fieldsToGenerate.join(", ")}.`
      : `Do NOT generate any "proposed" fields (leave "proposed" empty).`,
    altImageIds.length
      ? `Also write alt text in "imageAlts" for ONLY these photo ids: ${altImageIds.join(", ")}.`
      : `Leave "imageAlts" empty.`,
    "",
    "Ignore any pre-existing tags or metadata. Never invent attributes you have not seen in the photos, read in the close-up notes, or carried over as a non-visual detail. Do NOT output any brand/company/vendor name or placeholder text.",
    `The "focusKeyword" MUST be a concise 2-4 word search phrase that includes the core word(s) of the product name "${context.title}". Never use the full product title verbatim and never exceed 4 words.`,
    "Follow the character/format targets EXACTLY — they are graded by an automated scorer; aim for a perfect score — but never satisfy a target by adding a product claim you did not observe: pad with how it wears, how to style it, or care, not with invented features.",
    "",
    useVision && altImageIds.length ? `Photos are attached in order.` : "",
    "",
    "Return STRICT JSON only, no prose, with this exact shape:",
    SCHEMA,
  ].join("\n");
}

function buildProposed(
  parsed: any,
  current: SeoFields,
  focusKeyword: string,
  secondaryKeywords: string[],
): SeoFields {
  const p = parsed?.proposed || {};
  return {
    title: String(current.title || "").trim(),
    handle: String(current.handle || "").trim().toLowerCase(),
    seoTitle: String(p.seoTitle || current.seoTitle || "").trim(),
    metaDescription: String(p.metaDescription || current.metaDescription || "").trim(),
    bodyHtml: String(p.bodyHtml || current.bodyHtml || "").trim(),
    tags: p.tags != null ? asStringArray(p.tags, 20) : current.tags || [],
    productType: String(current.productType || "").trim(),
    vendor: String(current.vendor || "").trim(),
    imageAlts: current.imageAlts || [],
    focusKeyword,
    secondaryKeywords,
  };
}

export interface OptimizeInput {
  context: ProductContext;
  current: SeoFields;
  useVision?: boolean;
  /**
   * "photos" (default): whenever photos are available, the description, meta
   *   description and tags are written from the photos EVERY time — the
   *   previous text is reference material, never a reason to skip. A
   *   description can score 100 and still describe a different garment.
   * "weak-only": the older behaviour — regenerate only fields whose SEO score
   *   is below target, skip products already at target. The bulk pass uses
   *   this unless told otherwise, so a catalog at 100 is not rewritten by
   *   accident.
   */
  descriptionMode?: "photos" | "weak-only";
  /** The Studio's verified item spec (numbered lock list) for this product. */
  verifiedFacts?: string;
  apiKey: string;
}

export interface OptimizeResult {
  skipped: boolean;
  focusKeyword: string;
  secondaryKeywords: string[];
  visionUsed: boolean;
  imagesAnalyzed: number;
  /** What the model said it could see — the evidence behind the description. */
  observed: string[];
  /** The description was written from the photos (not merely score-repaired). */
  descriptionFromPhotos: boolean;
  /** The first draft came back as the previous text, so it was written again
   *  with that text withheld. */
  rewrittenFromPhotos?: boolean;
  verifiedFactsUsed: boolean;
  proposed: SeoFields;
  currentScorecard: Scorecard;
  proposedScorecard: Scorecard;
  imageAltsAdded: Array<{ id: string; altText: string }>;
  rationale: Partial<Record<SeoFieldKey, string>>;
  /** Set when the model came back with nothing usable; the caller decides how to report it. */
  error?: string;
}


/**
 * Guarantee the two fields Google actually shows.
 *
 * The model gets several passes at these and usually lands them, but "usually"
 * is not a guarantee, and every remaining failure is mechanical: a few
 * characters over, a few under, a missing keyword, no call to action. Those are
 * repairs that do not need a language model, so the last word is deterministic
 * and the score cannot come out below 100 for a reason arithmetic could fix.
 *
 * Nothing here invents a claim about the product. It reuses the words already
 * in the copy, the product name, and the focus keyword.
 */
function cut(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max + 1);
  const at = slice.lastIndexOf(" ");
  return (at > max * 0.6 ? slice.slice(0, at) : t.slice(0, max)).replace(/[\s,;:–—-]+$/, "");
}

function hasText(haystack: string, needle: string): boolean {
  const n = String(needle || "").trim().toLowerCase();
  if (!n) return true;
  return haystack.toLowerCase().includes(n);
}

function titleCase(v: string): string {
  return String(v || "").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Guarantee the SEO title.
 *
 * 30-60 characters with the focus keyword in it. Short titles are padded from
 * facts already on the product — its name, its type, the keyword the copy was
 * written around, the brand — rather than with adjectives, so nothing is
 * claimed here that was not already true.
 */
export function finishSeoTitle(
  value: string,
  keyword: string,
  productTitle: string,
  productType = "",
): string {
  const min = SEO_LIMITS.seoTitleMin;
  const max = SEO_LIMITS.seoTitleMax;
  const kw = String(keyword || "").trim();
  const name = String(productTitle || "").trim();

  let v = String(value || "").trim();
  if (!v) v = name || titleCase(kw);

  /* Keyword first, then trim, then grow — in that order. Growing first and
     trimming after can throw the padding straight back out, which is how a
     rescued title ended up at 15 characters. */
  if (kw && !hasText(v, kw)) {
    const joined = `${v} - ${titleCase(kw)}`;
    v = joined.length <= max ? joined : `${titleCase(kw)} - ${name}`;
  }
  if (v.length > max) {
    const trimmed = cut(v, max);
    /* Never trim the keyword back out: a shorter title beats one that no longer
       says what the page is for. */
    v = kw && !hasText(trimmed, kw) ? cut(`${titleCase(kw)} - ${name}`, max) : trimmed;
  }

  /* Pad from facts already on the product, most specific first, and only with a
     part that still fits — overshooting the maximum to satisfy the minimum
     trades one penalty for a bigger one. */
  const parts = [
    name,
    titleCase(kw),
    titleCase(productType),
    /* Long enough to carry a very short product name over the minimum on its
       own — "blazer" plus the brand alone still falls short — and true of every
       live product rather than a claim about this one. */
    "Shop Online at Carbon",
    "Order Today",
  ].filter(Boolean);
  for (const part of parts) {
    if (v.length >= min) break;
    if (hasText(v, part)) continue;
    const joined = `${v} - ${part}`;
    if (joined.length <= max) v = joined;
  }
  return v;
}

/**
 * Guarantee the meta description.
 *
 * 120-155 characters, containing the focus keyword and a call to action. Padding
 * sentences state only what is already true of any live product — that it can be
 * ordered, and where — so a guaranteed score never comes at the cost of a
 * guaranteed claim.
 */
export function finishMetaDescription(
  value: string,
  keyword: string,
  productTitle: string,
  productType = "",
): string {
  const min = SEO_LIMITS.metaDescriptionMin;
  const max = SEO_LIMITS.metaDescriptionMax;
  const kw = String(keyword || "").trim();
  const name = String(productTitle || "").trim();

  let v = String(value || "").trim();
  if (v && !/[.!?]$/.test(v)) v = `${v}.`;
  if (!v) v = name ? `${name}.` : `${titleCase(kw)}.`;

  if (kw && !hasText(v, kw)) v = `${titleCase(kw)}. ${v}`.trim();

  const filler = [
    kw ? `Shop ${kw} at Carbon.` : "",
    name ? `${name} is available to order online today.` : "",
    productType ? `Browse the full ${String(productType).toLowerCase()} range.` : "",
    "Discover more from the Carbon collection.",
    "Order online now.",
  ].filter(Boolean);

  for (const sentence of filler) {
    if (v.length >= min) break;
    if (hasText(v, sentence)) continue;
    const joined = `${v} ${sentence}`;
    /* Allow a sentence that lands inside the range, or that closes the gap
       without running past the maximum. */
    if (joined.length <= max) v = joined;
  }

  if (v.length > max) {
    /* Leave room for the full stop the cut removes, so the result is <= max
       rather than exactly one character over it. */
    v = cut(v, max - 1);
    if (!/[.!?]$/.test(v)) v = `${v}.`;
    if (kw && !hasText(v, kw)) {
      v = cut(`${titleCase(kw)}. ${v}`, max - 1);
      if (!/[.!?]$/.test(v)) v = `${v}.`;
    }
  }

  /* The scorer accepts a closing full stop OR an action word; the sentences
     above always end in one, so this only catches a value that arrived
     unpunctuated and long enough to need nothing else. */
  if (!/[.!?]$/.test(v) && !/(shop|discover|buy|free|now|today|get)/i.test(v)) v = `${v}.`;
  return v;
}

export async function optimizeSeo(input: OptimizeInput): Promise<OptimizeResult> {
  const { context, apiKey } = input;
  const useVision = input.useVision !== false;
  /* The "Complete the Look" banner is an image applied at write time, not
     something the model writes. It is stripped from the input here so the model
     is never shown it, the scorer judges the copy rather than boilerplate, and
     an older text-only version of the notice is cleared out. The write path puts
     the banner back. */
  const current: SeoFields = {
    ...input.current,
    bodyHtml: stripSetBanner(input.current.bodyHtml),
  };

  const currentScores = scoreAll(current);
  const weakFields = GEN_FIELDS.filter((f) => (currentScores.fields[f]?.score ?? 0) < TARGET_SCORE);
  const missingAlt = (current.imageAlts || []).filter(
    (a) => /^https?:\/\//i.test(String(a.url || "")) && !String(a.altText || "").trim(),
  );
  const photoMode = (input.descriptionMode ?? "photos") === "photos";
  const verifiedFacts = factsFromStudioSpec(String(input.verifiedFacts || ""));
  const previousDescription = stripHtml(current.bodyHtml || "").replace(/\s+/g, " ").trim().slice(0, PREVIOUS_DESCRIPTION_MAX);

  /* The handle is derived, not written: the correct value is the product name
     and a model has nothing to add to that. Computed up front so it applies on
     the skip path too — a product whose copy is already perfect can still be
     sitting on a slug left over from an older name. */
  const nextHandle = desiredHandle(current.handle, current.title);

  /* Photos in Shopify position order: the hero and the next few carry the
     garment; those go in at high detail. Beyond that, photos still missing
     alt text come first (they need alt text written), up to the cap. */
  const httpsImages = (current.imageAlts || []).filter((a) => /^https?:\/\//i.test(String(a.url || "")));
  const altIdSet = new Set(missingAlt.map((a) => String(a.id)));
  const primary = httpsImages.slice(0, HIGH_DETAIL_IMAGES);
  const secondary = httpsImages
    .slice(HIGH_DETAIL_IMAGES)
    .sort((a, b) => (altIdSet.has(String(b.id)) ? 1 : 0) - (altIdSet.has(String(a.id)) ? 1 : 0))
    .slice(0, Math.max(0, MAX_VISION_IMAGES - primary.length));
  const candidateImages = [...primary, ...secondary];
  /* In photo mode a product with photos is never "already optimized": the
     copy is rewritten from what the photos show, whatever it scores. */
  const groundable = photoMode && useVision && candidateImages.length > 0;

  if (!groundable && currentScores.overall >= OVERALL_TARGET && !missingAlt.length && !nextHandle) {
    return {
      skipped: true,
      focusKeyword: String((current as any).focusKeyword || ""),
      secondaryKeywords: [],
      visionUsed: false,
      imagesAnalyzed: 0,
      observed: [],
      descriptionFromPhotos: false,
      verifiedFactsUsed: false,
      proposed: { ...current },
      currentScorecard: currentScores,
      proposedScorecard: currentScores,
      imageAltsAdded: [],
      rationale: {},
    };
  }

  const images: { id: string; dataUrl: string }[] = [];
  if (useVision) {
    const fetched = await Promise.allSettled(
      candidateImages.map(async (a) => {
        const safeUrl = normalizeRemoteImageUrl(String(a.url));
        const { bytes, contentType } = await fetchRemoteImageBytes(safeUrl, {
          timeoutMs: getImageFetchTimeoutMs(),
        });
        return {
          id: String(a.id),
          dataUrl: `data:${contentType || "image/jpeg"};base64,${bytes.toString("base64")}`,
        };
      }),
    );
    for (const f of fetched) if (f.status === "fulfilled") images.push(f.value);
  }
  /* The product HAS photos and not one of them could be read. In photos mode
     that is a failure, not a licence to describe the garment from its name:
     writing a confident description with nothing to check it against is the
     exact outcome this mode exists to prevent. */
  if (photoMode && useVision && candidateImages.length > 0 && images.length === 0) {
    return {
      skipped: false,
      focusKeyword: String((current as any).focusKeyword || ""),
      secondaryKeywords: [],
      visionUsed: false,
      imagesAnalyzed: 0,
      observed: [],
      descriptionFromPhotos: false,
      verifiedFactsUsed: false,
      proposed: { ...current },
      currentScorecard: currentScores,
      proposedScorecard: currentScores,
      imageAltsAdded: [],
      rationale: {},
      error: `Could not read any of this product's ${candidateImages.length} photo(s), so the description cannot be based on them. Please retry.`,
    };
  }
  const visionActive = useVision && images.length > 0;
  const altImageIds = images.filter((img) => altIdSet.has(img.id)).map((img) => img.id);
  /* Photos reached the model → the copy is written from them, not just repaired. */
  const groundInPhotos = photoMode && visionActive;
  /* High detail goes to the first photos that actually DOWNLOADED, in order —
     keying it off the intended primaries meant three failed heroes left every
     surviving photo at the ~512 px "auto" size with nothing legible on it. */
  const highDetailIds = new Set(images.slice(0, HIGH_DETAIL_IMAGES).map((img) => img.id));
  /* What to (re)write. In photos mode the claim-carrying fields are rewritten
     whatever they score; everything else stays score-driven, so a product
     nobody changed does not come back with different tags every visit. */
  const fieldsToGen: SeoFieldKey[] = groundInPhotos
    ? GEN_FIELDS.filter((f) => CLAIM_FIELDS.includes(f) || weakFields.includes(f))
    : weakFields;

  const ctx = context;
  const cur = current;
  const openai = new OpenAI({ apiKey });
  const imageParts: any[] = visionActive
    ? images.map((img) => ({
        type: "image_url",
        image_url: { url: img.dataUrl, detail: highDetailIds.has(img.id) ? "high" : "auto" },
      }))
    : [];
  const extras: GenExtras = {
    previousDescription: groundInPhotos ? previousDescription : "",
    verifiedFacts,
  };

  async function callGenerate(
    fieldsToGen: SeoFieldKey[],
    altIds: string[],
    temperature: number,
    extrasOverride?: GenExtras,
  ): Promise<any> {
    const content: any[] = [
      { type: "text", text: buildGenInstruction(ctx, fieldsToGen, visionActive, altIds, extrasOverride ?? extras) },
      ...imageParts,
    ];
    const c: any = await withTimeout(
      openai.chat.completions.create({
        model: MODEL,
        temperature,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You generate apparel e-commerce SEO from a product name, colour and the product photos, which are the source of truth. Close-up notes and any previous description are reference material and never override what the photos show. Return only valid JSON.",
          },
          { role: "user", content },
        ],
      }),
      TIMEOUT_MS,
      "SEO optimize",
    );
    return parseJsonObjectFromText(c?.choices?.[0]?.message?.content || "");
  }

  function applyGenerated(target: SeoFields, src: any, fields: SeoFieldKey[]): SeoFields {
    const out: SeoFields = { ...target, tags: [...(target.tags || [])] };
    for (const f of fields) {
      if (src?.[f] == null) continue;
      if (f === "tags") out.tags = asStringArray(src.tags, 20);
      else (out as any)[f] = String(src[f]).trim();
    }
    return out;
  }

  const parsed = await callGenerate(fieldsToGen, altImageIds, 0.4);
  if (!parsed || (fieldsToGen.length && !parsed.proposed)) {
    return {
      skipped: false,
      focusKeyword: "",
      secondaryKeywords: [],
      visionUsed: visionActive,
      imagesAnalyzed: images.length,
      observed: [],
      descriptionFromPhotos: false,
      verifiedFactsUsed: Boolean(extras.verifiedFacts),
      proposed: { ...current },
      currentScorecard: currentScores,
      proposedScorecard: currentScores,
      imageAltsAdded: [],
      rationale: {},
      error: "Optimizer returned no usable result. Please retry.",
    };
  }
  let observed = asObservedList(parsed.observed);
  /* Did the model actually write a description this run? An omitted field
     falls back to the current text in buildProposed, and reporting THAT as
     "written from the photos" is a lie the operator would act on. */
  let modelWroteBody = typeof parsed?.proposed?.bodyHtml === "string" && parsed.proposed.bodyHtml.trim().length > 0;

  /* The scorer checks three fields against the focus keyword and counts an empty
     one as a miss — deliberately, since that is what exposed the keyword never
     being persisted. So it must never be empty: with no keyword from the model,
     the product name is the keyword. */
  const focusKeyword =
    String(parsed.focusKeyword || "").trim() || String(cur.title || "").trim().toLowerCase();
  const secondaryKeywords = asStringArray(parsed.secondaryKeywords, 8);
  const rationale: Partial<Record<SeoFieldKey, string>> = {};
  if (parsed.rationale && typeof parsed.rationale === "object") {
    for (const [k, v] of Object.entries(parsed.rationale)) rationale[k as SeoFieldKey] = String(v || "").trim();
  }

  let proposed = buildProposed(parsed, cur, focusKeyword, secondaryKeywords);
  for (const f of GEN_FIELDS) {
    if (!fieldsToGen.includes(f)) {
      if (f === "tags") proposed.tags = cur.tags || [];
      else (proposed as any)[f] = (cur as any)[f];
    }
  }
  let proposedScorecard = scoreAll(proposed);

  async function refineToTarget() {
    for (let pass = 0; pass < MAX_REPAIRS; pass += 1) {
      const weak = fieldsToGen.filter((f) => (proposedScorecard.fields[f]?.score ?? 0) < TARGET_SCORE);
      if (!weak.length) break;
      const repairPrompt = [
        "Improve ONLY these SEO fields so each fully satisfies its rule (they are auto-graded; aim for 100). Keep the same product and focus keyword. Never add, remove or change a product fact — fix only length, structure, wording and keyword placement; pad with how it wears or styles, never with invented features.",
        ...(observed.length ? [`The facts the description is built on (do not go beyond them): ${observed.join("; ")}`] : []),
        `Focus keyword: "${focusKeyword}"`,
        "Current values and the problems to fix:",
        ...weak.map((f) => {
          const fs = proposedScorecard.fields[f];
          const val = f === "tags" ? (proposed.tags || []).join(", ") : String((proposed as any)[f] ?? "");
          return `• ${f}: ${JSON.stringify(val).slice(0, 600)}\n   issues: ${(fs?.issues || []).join(" ") || "raise quality"}`;
        }),
        "",
        "Targets: seoTitle 40-60 chars w/ keyword; metaDescription 130-155 chars w/ keyword + CTA; bodyHtml HTML (<p> + <ul> 4-6 <li> + <p>), 450-850 chars text, keyword present; tags 7-12 lowercase deduped.",
        `Return STRICT JSON only: { ${weak.map((f) => `"${f}": ${f === "tags" ? "string[]" : "string"}`).join(", ")} }`,
      ].join("\n");
      let repair: any = null;
      try {
        const rc: any = await withTimeout(
          openai.chat.completions.create({
            model: MODEL,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "You refine SEO fields to satisfy strict formatting rules. Return only valid JSON." },
              { role: "user", content: repairPrompt },
            ],
          }),
          TIMEOUT_MS,
          "SEO repair",
        );
        repair = parseJsonObjectFromText(rc?.choices?.[0]?.message?.content || "");
      } catch {
        break;
      }
      if (!repair) break;
      proposed = applyGenerated(proposed, repair, weak);
      proposedScorecard = scoreAll(proposed);
    }
  }

  /* The model was shown the previous description and handed it straight back.
     Ask again with that text withheld, so it has nothing to copy and must
     write from the photos. One extra call, only when it actually happened. */
  let rewrittenFromPhotos = false;
  if (groundInPhotos && previousDescription && fieldsToGen.includes("bodyHtml")) {
    const overlap = reusedFraction(proposed.bodyHtml, previousDescription);
    if (overlap > MAX_REUSED_FRACTION) {
      const claimFields = fieldsToGen.filter((f) => CLAIM_FIELDS.includes(f));
      const rewrite = await callGenerate(claimFields, [], 0.6, { ...extras, previousDescription: "" }).catch(() => null);
      if (rewrite?.proposed?.bodyHtml) {
        proposed = applyGenerated(proposed, rewrite.proposed, claimFields);
        proposedScorecard = scoreAll(proposed);
        const fresh = asObservedList(rewrite.observed);
        if (fresh.length) observed = fresh;
        modelWroteBody = true;
        rewrittenFromPhotos = true;
        console.warn(
          `[seo] description was ${Math.round(overlap * 100)}% the previous text; regenerated from the photos alone ` +
            `(now ${Math.round(reusedFraction(proposed.bodyHtml, previousDescription) * 100)}%).`,
        );
      }
    }
  }
  await refineToTarget();

  for (let attempt = 0; attempt < MAX_REGEN && proposedScorecard.overall < OVERALL_TARGET; attempt += 1) {
    const stillWeak = fieldsToGen.filter((f) => (proposedScorecard.fields[f]?.score ?? 0) < TARGET_SCORE);
    if (!stillWeak.length) break;
    const reparsed = await callGenerate(stillWeak, [], 0.6).catch(() => null);
    if (!reparsed?.proposed) continue;
    const candidate = applyGenerated(proposed, reparsed.proposed, stillWeak);
    const candidateCard = scoreAll(candidate);
    if (candidateCard.overall >= proposedScorecard.overall) {
      proposed = candidate;
      proposedScorecard = candidateCard;
      /* The evidence must describe the copy actually being shipped. */
      const regenObserved = asObservedList(reparsed.observed);
      if (regenObserved.length) observed = regenObserved;
      if (stillWeak.includes("bodyHtml") && typeof reparsed.proposed.bodyHtml === "string" && reparsed.proposed.bodyHtml.trim()) {
        modelWroteBody = true;
      }
      await refineToTarget();
    }
  }

  const currentScorecard = scoreAll({ ...cur, focusKeyword, secondaryKeywords });

  /* Last word on the two fields Google shows. BEFORE the clamp, so the clamp
     compares what would actually ship against what is live — it used to judge
     a raw value that the finisher was about to bring up to 100, and throw a
     photo-grounded meta description away on a score it never really had. */
  proposed.seoTitle = finishSeoTitle(proposed.seoTitle, focusKeyword, cur.title, cur.productType);
  proposed.metaDescription = finishMetaDescription(
    proposed.metaDescription,
    focusKeyword,
    cur.title,
    cur.productType,
  );
  proposedScorecard = scoreAll(proposed);

  /* Never hand back a field that scores worse than what is already live —
     except the claim-carrying fields written from the photos: a true
     description a few points under a polished but wrong one is the whole
     point of this mode. */
  let clamped = false;
  for (const f of GEN_FIELDS) {
    if (groundInPhotos && CLAIM_FIELDS.includes(f)) continue;
    const ps = proposedScorecard.fields[f]?.score ?? 0;
    const cs = currentScorecard.fields[f]?.score ?? 0;
    if (ps < cs) {
      if (f === "tags") proposed.tags = cur.tags || [];
      else (proposed as any)[f] = (cur as any)[f];
      clamped = true;
    }
  }
  if (clamped) proposedScorecard = scoreAll(proposed);
  if (nextHandle) {
    proposed.handle = nextHandle;
    rationale.handle = `The URL should be the product name. Old links keep working: a 301 redirect from "${cur.handle}" is created when this is published.`;
  }
  proposedScorecard = scoreAll(proposed);

  const altMap = new Map<string, string>(
    (Array.isArray(parsed.imageAlts) ? parsed.imageAlts : [])
      .map((x: any) => [String(x?.id || ""), String(x?.alt || "").trim()] as [string, string])
      .filter((e: [string, string]) => e[0] && e[1]),
  );
  const imageAltsAdded: Array<{ id: string; altText: string }> = [];
  proposed.imageAlts = (current.imageAlts || []).map((a) => {
    const id = String(a.id);
    const gen = altIdSet.has(id) ? altMap.get(id) || "" : "";
    if (gen) {
      imageAltsAdded.push({ id, altText: gen });
      return { ...a, altText: gen };
    }
    return a;
  });

  return {
    skipped: false,
    focusKeyword,
    secondaryKeywords,
    visionUsed: visionActive,
    imagesAnalyzed: visionActive ? images.length : 0,
    observed,
    descriptionFromPhotos: groundInPhotos && modelWroteBody,
    rewrittenFromPhotos,
    verifiedFactsUsed: Boolean(extras.verifiedFacts),
    proposed,
    currentScorecard,
    proposedScorecard,
    imageAltsAdded,
    rationale,
  };
}
