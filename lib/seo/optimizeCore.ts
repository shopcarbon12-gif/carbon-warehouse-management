/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI from "openai";
import { withTimeout, parseJsonObjectFromText, asStringArray } from "@/lib/seo/aiText";
import { scoreAll } from "@/lib/seo/deterministic";
import type { ProductContext, SeoFields, SeoFieldKey, Scorecard } from "@/lib/seo/types";
import { fetchRemoteImageBytes, normalizeRemoteImageUrl, getImageFetchTimeoutMs } from "@/lib/remoteImage";
import { applySetNotice, stripSetNotice } from "@/lib/seo/setNotice";

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

export async function optimizeSeo(input: OptimizeInput): Promise<OptimizeResult> {
  const { context, apiKey } = input;
  const useVision = input.useVision !== false;
  const isSet = Boolean(context.isSet);

  /* The set notice is appended after generation, so it is stripped here first:
     the model must not be shown boilerplate it might imitate or reword, and the
     scorer should judge the written copy rather than a block that is always
     identical. It goes back on at the end. */
  const current: SeoFields = {
    ...input.current,
    bodyHtml: stripSetNotice(input.current.bodyHtml),
  };

  const currentScores = scoreAll(current);
  const weakFields = GEN_FIELDS.filter((f) => (currentScores.fields[f]?.score ?? 0) < TARGET_SCORE);
  const missingAlt = (current.imageAlts || []).filter(
    (a) => /^https?:\/\//i.test(String(a.url || "")) && !String(a.altText || "").trim(),
  );

  if (currentScores.overall >= OVERALL_TARGET && !missingAlt.length) {
    /* Nothing to rewrite, but the set flag may have changed since the copy was
       written — the notice still has to match it. */
    const settled: SeoFields = { ...current, bodyHtml: applySetNotice(current.bodyHtml, isSet) };
    return {
      skipped: true,
      focusKeyword: String((current as any).focusKeyword || ""),
      secondaryKeywords: [],
      visionUsed: false,
      imagesAnalyzed: 0,
      proposed: settled,
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

  const focusKeyword = String(parsed.focusKeyword || "").trim();
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

  /* Fixed wording, appended last so nothing downstream can reword it, and only
     for products flagged as part of a set. When the flag is off this also
     removes a notice a product used to carry. */
  proposed.bodyHtml = applySetNotice(proposed.bodyHtml, isSet);

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
