// Deterministic, rule-based SEO scoring. Pure & isomorphic (no Node APIs) so it
// can run in the API routes AND in the browser for instant re-scoring on edits.

import {
  type FieldScore,
  type Grade,
  type Scorecard,
  type SeoFields,
  type SeoFieldKey,
  SEO_LIMITS,
} from "./types";

export function gradeFromScore(score: number): Grade {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function stripHtml(html: string): string {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function tokenize(text: string): string[] {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
}

/** Does `haystack` contain the focus keyword (or most of its words)? */
function containsKeyword(haystack: string, keyword?: string): boolean {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return false;
  const hay = String(haystack || "").toLowerCase();
  if (hay.includes(kw)) return true;
  const words = tokenize(kw);
  if (!words.length) return false;
  const hits = words.filter((w) => hay.includes(w)).length;
  return hits / words.length >= 0.6;
}

function mk(score: number, issues: string[], why: string): FieldScore {
  const s = clamp(score);
  return { score: s, grade: gradeFromScore(s), issues, why };
}

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "with", "in", "on", "by",
]);

export function scoreSeoTitle(fields: SeoFields): FieldScore {
  const v = String(fields.seoTitle || "").trim();
  const issues: string[] = [];
  if (!v) return mk(0, ["No SEO title set."], "Empty — Google will fall back to the product title, often truncated.");
  let score = 100;
  const len = v.length;
  if (len < SEO_LIMITS.seoTitleMin) {
    score -= 30;
    issues.push(`Too short (${len} chars; aim ${SEO_LIMITS.seoTitleMin}-${SEO_LIMITS.seoTitleMax}).`);
  } else if (len > SEO_LIMITS.seoTitleMax) {
    score -= 25;
    issues.push(`Too long (${len} chars; Google truncates ~${SEO_LIMITS.seoTitleMax}).`);
  }
  if (!containsKeyword(v, fields.focusKeyword)) {
    score -= 25;
    issues.push("Focus keyword not present.");
  }
  // Brand/vendor is intentionally kept OUT of the generated copy, so it is not required here.
  return mk(score, issues, `${len} chars. Title tag is the strongest on-page ranking + click signal.`);
}

export function scoreMetaDescription(fields: SeoFields): FieldScore {
  const v = String(fields.metaDescription || "").trim();
  const issues: string[] = [];
  if (!v) return mk(0, ["No meta description set."], "Empty — Google auto-generates a snippet you don't control.");
  let score = 100;
  const len = v.length;
  if (len < SEO_LIMITS.metaDescriptionMin) {
    score -= 25;
    issues.push(`Too short (${len} chars; aim ${SEO_LIMITS.metaDescriptionMin}-${SEO_LIMITS.metaDescriptionMax}).`);
  } else if (len > SEO_LIMITS.metaDescriptionMax) {
    score -= 20;
    issues.push(`Too long (${len} chars; truncated ~${SEO_LIMITS.metaDescriptionMax}).`);
  }
  if (!containsKeyword(v, fields.focusKeyword)) {
    score -= 20;
    issues.push("Focus keyword not present.");
  }
  if (!/[.!?]$/.test(v) && !/(shop|discover|buy|free|now|today|get)/i.test(v)) {
    score -= 10;
    issues.push("No clear call-to-action.");
  }
  return mk(score, issues, `${len} chars. Controls the search snippet and drives click-through.`);
}

export function scoreHandle(fields: SeoFields): FieldScore {
  const v = String(fields.handle || "").trim();
  const issues: string[] = [];
  if (!v) return mk(0, ["No handle."], "Empty URL slug.");
  let score = 100;
  if (/[^a-z0-9-]/.test(v)) {
    score -= 30;
    issues.push("Contains characters other than lowercase, digits, hyphens.");
  }
  if (v.includes("_")) {
    score -= 10;
    issues.push("Uses underscores; hyphens are preferred.");
  }
  if (v.length > SEO_LIMITS.handleMax) {
    score -= 15;
    issues.push(`Too long (${v.length} chars).`);
  }
  if (v.length < SEO_LIMITS.handleMin) {
    score -= 20;
    issues.push("Too short to be descriptive.");
  }
  const words = v.split("-").filter(Boolean);
  const stopCount = words.filter((w) => STOP_WORDS.has(w)).length;
  if (stopCount >= 2) {
    score -= 8;
    issues.push("Contains filler/stop words.");
  }
  // The handle is a PRESERVED brand-name slug (e.g. "untimely-shirt"); it is not
  // required to contain the descriptive focus keyword. Cleanliness is what matters.
  return mk(score, issues, `${v.length} chars. A clean, brand-name URL slug.`);
}

export function scoreTitle(fields: SeoFields): FieldScore {
  const v = String(fields.title || "").trim();
  const issues: string[] = [];
  if (!v) return mk(0, ["No product title."], "Empty H1.");
  let score = 100;
  const len = v.length;
  // The product title is a PRESERVED WMS brand name (often a short, clean name like
  // "TIGER SHIRT"). Its length is not an SEO lever here, so it is not penalized;
  // only a gentle keyword nudge applies.
  if (len > SEO_LIMITS.titleMax) {
    score -= 10;
    issues.push(`Long (${len} chars).`);
  }
  // Preserved brand title — not required to contain the descriptive focus keyword.
  return mk(score, issues, `${len} chars. Preserved product title.`);
}

export function scoreBody(fields: SeoFields): FieldScore {
  const text = stripHtml(fields.bodyHtml);
  const issues: string[] = [];
  if (!text) return mk(0, ["No description."], "Empty body — thin content ranks poorly.");
  let score = 100;
  const chars = text.length;
  if (chars < SEO_LIMITS.bodyMinChars) {
    score -= 35;
    issues.push(`Thin content (${chars} chars; aim ${SEO_LIMITS.bodyMinChars}+).`);
  }
  const hasStructure = /<(ul|ol|li|h[1-6]|p|br)/i.test(fields.bodyHtml || "");
  if (!hasStructure) {
    score -= 15;
    issues.push("No structure (headings/bullets) — hard to scan.");
  }
  if (!containsKeyword(text, fields.focusKeyword)) {
    score -= 20;
    issues.push("Focus keyword not present in body.");
  }
  return mk(score, issues, `${chars} chars of text. Rich, structured copy wins long-tail traffic.`);
}

export function scoreTags(fields: SeoFields): FieldScore {
  const tags = (fields.tags || []).map((t) => String(t || "").trim()).filter(Boolean);
  const issues: string[] = [];
  let score = 100;
  if (tags.length < SEO_LIMITS.tagsMin) {
    score -= 40;
    issues.push(`Only ${tags.length} tags (aim ${SEO_LIMITS.tagsMin}+).`);
  } else if (tags.length > SEO_LIMITS.tagsMax) {
    score -= 15;
    issues.push(`Many tags (${tags.length}); keep them relevant.`);
  }
  const lowered = tags.map((t) => t.toLowerCase());
  if (new Set(lowered).size !== lowered.length) {
    score -= 10;
    issues.push("Duplicate tags.");
  }
  return mk(score, issues, `${tags.length} tags. Power faceted search and internal relevance.`);
}

export function scoreProductType(fields: SeoFields): FieldScore {
  const v = String(fields.productType || "").trim();
  if (!v) return mk(0, ["No product type."], "Empty — weakens taxonomy and Google product categorization.");
  return mk(100, [], "Set — feeds collections and structured data category.");
}

export function scoreVendor(fields: SeoFields): FieldScore {
  const v = String(fields.vendor || "").trim();
  if (!v) return mk(0, ["No vendor/brand."], "Empty — brand is required for rich product results.");
  return mk(100, [], "Set — brand powers Google rich results & social previews.");
}

export function scoreImageAlts(fields: SeoFields): FieldScore {
  const imgs = fields.imageAlts || [];
  const issues: string[] = [];
  if (!imgs.length) return mk(50, ["No images to evaluate."], "No images on this product.");
  const withAlt = imgs.filter((i) => String(i.altText || "").trim().length > 0);
  const goodLen = withAlt.filter((i) => {
    const l = i.altText.trim().length;
    return l >= SEO_LIMITS.altMin && l <= SEO_LIMITS.altMax;
  });
  const coverage = withAlt.length / imgs.length;
  const score = Math.round(coverage * 70 + (goodLen.length / imgs.length) * 30);
  if (withAlt.length < imgs.length) {
    issues.push(`${imgs.length - withAlt.length}/${imgs.length} images missing alt text.`);
  }
  if (goodLen.length < withAlt.length) {
    issues.push("Some alt texts are too short/long.");
  }
  return mk(score, issues, `${withAlt.length}/${imgs.length} images described. Alt text = accessibility + image SEO.`);
}

const WEIGHTS: Record<SeoFieldKey, number> = {
  seoTitle: 0.18,
  metaDescription: 0.18,
  bodyHtml: 0.15,
  title: 0.12,
  imageAlts: 0.12,
  handle: 0.1,
  tags: 0.06,
  productType: 0.05,
  vendor: 0.04,
};

const SCORERS: Record<SeoFieldKey, (f: SeoFields) => FieldScore> = {
  seoTitle: scoreSeoTitle,
  metaDescription: scoreMetaDescription,
  handle: scoreHandle,
  title: scoreTitle,
  bodyHtml: scoreBody,
  tags: scoreTags,
  productType: scoreProductType,
  vendor: scoreVendor,
  imageAlts: scoreImageAlts,
};

/** Full deterministic scorecard for a set of SEO fields. */
export function scoreAll(fields: SeoFields): Scorecard {
  const out: Partial<Record<SeoFieldKey, FieldScore>> = {};
  let weighted = 0;
  let totalWeight = 0;
  (Object.keys(SCORERS) as SeoFieldKey[]).forEach((key) => {
    const fs = SCORERS[key](fields);
    out[key] = fs;
    weighted += fs.score * WEIGHTS[key];
    totalWeight += WEIGHTS[key];
  });
  const overall = clamp(totalWeight ? weighted / totalWeight : 0);
  return { overall, grade: gradeFromScore(overall), fields: out };
}

/**
 * Blend an LLM qualitative score (0-100 per field) into a deterministic
 * scorecard, 50/50. Keeps the deterministic issues/why text. Used to combine
 * rule-based checks with the model's judgment for the comparison view.
 */
export function blendLlmScores(
  det: Scorecard,
  llm?: Partial<Record<SeoFieldKey, number>>
): Scorecard {
  if (!llm) return det;
  const fields: Partial<Record<SeoFieldKey, FieldScore>> = {};
  let weighted = 0;
  let totalWeight = 0;
  (Object.keys(det.fields) as SeoFieldKey[]).forEach((key) => {
    const d = det.fields[key];
    if (!d) return;
    const l = llm[key];
    const blended = typeof l === "number" && Number.isFinite(l) ? clamp(0.5 * d.score + 0.5 * l) : d.score;
    fields[key] = { ...d, score: blended, grade: gradeFromScore(blended) };
    weighted += blended * WEIGHTS[key];
    totalWeight += WEIGHTS[key];
  });
  const overall = clamp(totalWeight ? weighted / totalWeight : 0);
  return { overall, grade: gradeFromScore(overall), fields };
}
