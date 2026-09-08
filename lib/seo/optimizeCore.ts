/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI from "openai";
import { desiredHandle } from "./handle";
import { withTimeout, parseJsonObjectFromText, asStringArray } from "@/lib/seo/aiText";
import { scoreAll } from "@/lib/seo/deterministic";
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
const MAX_VISION_IMAGES = Math.max(1, Math.min(Number(process.env.SEO_MAX_IMAGES) || 6, 10));
const TARGET_SCORE = 100;
const OVERALL_TARGET = Math.max(80, Math.min(Number(process.env.SEO_OVERALL_TARGET) || 98, 100));
const MAX_REPAIRS = 3;
const MAX_REGEN = 2;

const GEN_FIELDS: SeoFieldKey[] = ["seoTitle", "metaDescription", "bodyHtml", "tags"];

const SCHEMA = `{
  "focusKeyword": string,
  "secondaryKeywords": string[],
  "proposed": {
    "seoTitle": string,
    "metaDescription": string,
    "bodyHtml": string,
    "tags": string[]
  },
  "imageAlts": [ { "id": string, "alt": string } ],
  "rationale": { "seoTitle": string, "metaDescription": string, "bodyHtml": string, "tags": string }
}`;

function buildGenInstruction(
  context: ProductContext,
  fieldsToGenerate: SeoFieldKey[],
  useVision: boolean,
  altImageIds: string[],
) {
  const colors = (context.colors || []).join(", ") || "(not specified)";
  return [
    "You are a senior e-commerce SEO strategist and apparel product-photo analyst.",
    "",
    "Generate SEO using ONLY these inputs:",
    `  • Product name: "${context.title}"`,
    `  • Color(s): ${colors}`,
    useVision
      ? "  • The product PHOTOS provided in this message (analyze them)."
      : "  • (No photos provided — use the name and color only.)",
    "",
    "Do NOT change or output the product title or the URL handle — they are fixed.",
    fieldsToGenerate.length
      ? `Generate ONLY these "proposed" fields (omit all others): ${fieldsToGenerate.join(", ")}.`
      : `Do NOT generate any "proposed" fields (leave "proposed" empty).`,
    altImageIds.length
      ? `Also write alt text in "imageAlts" for ONLY these photo ids: ${altImageIds.join(", ")}.`
      : `Leave "imageAlts" empty.`,
    "",
    "Ignore any pre-existing description, tags, or metadata. Base details (fabric, fit, neckline, sleeves, print/pattern, hardware, silhouette) ONLY on what you can SEE plus the name and color. Never invent attributes that aren't visible. Do NOT output any brand/company/vendor name or placeholder text.",
    `The "focusKeyword" MUST be a concise 2-4 word search phrase that includes the core word(s) of the product name "${context.title}". Never use the full product title verbatim and never exceed 4 words.`,
    "Follow the character/format targets EXACTLY — they are graded by an automated scorer; aim for a perfect score.",
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
  apiKey: string;
}

export interface OptimizeResult {
  skipped: boolean;
  focusKeyword: string;
  secondaryKeywords: string[];
  visionUsed: boolean;
  imagesAnalyzed: number;
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

  /* The handle is derived, not written: the correct value is the product name
     and a model has nothing to add to that. Computed up front so it applies on
     the skip path too — a product whose copy is already perfect can still be
     sitting on a slug left over from an older name. */
  const nextHandle = desiredHandle(current.handle, current.title);

  if (currentScores.overall >= OVERALL_TARGET && !missingAlt.length && !nextHandle) {
    return {
      skipped: true,
      focusKeyword: String((current as any).focusKeyword || ""),
      secondaryKeywords: [],
      visionUsed: false,
      imagesAnalyzed: 0,
      proposed: { ...current },
      currentScorecard: currentScores,
      proposedScorecard: currentScores,
      imageAltsAdded: [],
      rationale: {},
    };
  }

  const altIdSet = new Set(missingAlt.map((a) => String(a.id)));
  const candidateImages = (current.imageAlts || [])
    .filter((a) => /^https?:\/\//i.test(String(a.url || "")))
    .sort((a, b) => (altIdSet.has(String(b.id)) ? 1 : 0) - (altIdSet.has(String(a.id)) ? 1 : 0))
    .slice(0, MAX_VISION_IMAGES);

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
  const visionActive = useVision && images.length > 0;
  const altImageIds = images.filter((img) => altIdSet.has(img.id)).map((img) => img.id);

  const ctx = context;
  const cur = current;
  const openai = new OpenAI({ apiKey });
  const imageParts: any[] = visionActive
    ? images.map((img) => ({ type: "image_url", image_url: { url: img.dataUrl, detail: "auto" } }))
    : [];

  async function callGenerate(fieldsToGen: SeoFieldKey[], altIds: string[], temperature: number): Promise<any> {
    const content: any[] = [
      { type: "text", text: buildGenInstruction(ctx, fieldsToGen, visionActive, altIds) },
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
              "You generate apparel e-commerce SEO from a product name, color, and photos only. Return only valid JSON.",
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

  const parsed = await callGenerate(weakFields, altImageIds, 0.4);
  if (!parsed || (weakFields.length && !parsed.proposed)) {
    return {
      skipped: false,
      focusKeyword: "",
      secondaryKeywords: [],
      visionUsed: visionActive,
      imagesAnalyzed: images.length,
      proposed: { ...current },
      currentScorecard: currentScores,
      proposedScorecard: currentScores,
      imageAltsAdded: [],
      rationale: {},
      error: "Optimizer returned no usable result. Please retry.",
    };
  }

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
    if (!weakFields.includes(f)) {
      if (f === "tags") proposed.tags = cur.tags || [];
      else (proposed as any)[f] = (cur as any)[f];
    }
  }
  let proposedScorecard = scoreAll(proposed);

  async function refineToTarget() {
    for (let pass = 0; pass < MAX_REPAIRS; pass += 1) {
      const weak = weakFields.filter((f) => (proposedScorecard.fields[f]?.score ?? 0) < TARGET_SCORE);
      if (!weak.length) break;
      const repairPrompt = [
        "Improve ONLY these SEO fields so each fully satisfies its rule (they are auto-graded; aim for 100). Keep the same product, focus keyword, and visible facts.",
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

  await refineToTarget();

  for (let attempt = 0; attempt < MAX_REGEN && proposedScorecard.overall < OVERALL_TARGET; attempt += 1) {
    const stillWeak = weakFields.filter((f) => (proposedScorecard.fields[f]?.score ?? 0) < TARGET_SCORE);
    if (!stillWeak.length) break;
    const reparsed = await callGenerate(stillWeak, [], 0.6).catch(() => null);
    if (!reparsed?.proposed) continue;
    const candidate = applyGenerated(proposed, reparsed.proposed, stillWeak);
    const candidateCard = scoreAll(candidate);
    if (candidateCard.overall >= proposedScorecard.overall) {
      proposed = candidate;
      proposedScorecard = candidateCard;
      await refineToTarget();
    }
  }

  const currentScorecard = scoreAll({ ...cur, focusKeyword, secondaryKeywords });

  let clamped = false;
  for (const f of GEN_FIELDS) {
    const ps = proposedScorecard.fields[f]?.score ?? 0;
    const cs = currentScorecard.fields[f]?.score ?? 0;
    if (ps < cs) {
      if (f === "tags") proposed.tags = cur.tags || [];
      else (proposed as any)[f] = (cur as any)[f];
      clamped = true;
    }
  }
  if (clamped) proposedScorecard = scoreAll(proposed);

  /* Last word on the two fields Google shows, and on the handle. After the
     clamp, so a repair here cannot be reverted by it. */
  proposed.seoTitle = finishSeoTitle(proposed.seoTitle, focusKeyword, cur.title, cur.productType);
  proposed.metaDescription = finishMetaDescription(
    proposed.metaDescription,
    focusKeyword,
    cur.title,
    cur.productType,
  );
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
    proposed,
    currentScorecard,
    proposedScorecard,
    imageAltsAdded,
    rationale,
  };
}
