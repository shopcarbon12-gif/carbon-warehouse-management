/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI, { toFile } from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkGenerateRateLimit } from "@/lib/generate-ratelimit";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import {
  fetchRemoteImageBytes,
  getImageFetchMaxBytes,
  getImageFetchTimeoutMs,
  normalizeRemoteImageUrl,
} from "@/lib/remoteImage";
import { downloadStorageObject, tryGetStoragePathFromUrl } from "@/lib/storageProvider";
import { buildPoseVariationDirective, normalizeStrength } from "@/lib/poseVariation";

const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAFx0lEQVR42u3UwQkAIBDAMHX/nc8lBK4jUZBkn2tmdgDg53YHAH4MIAgQCBAECAQIAgQCBAECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIhD8eQ9JCmqo2AAAAAElFTkSuQmCC";

function getClientKey(req: NextRequest) {
  const forwarded = req.headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim();
  return ip || "unknown";
}

function extFromContentType(contentType: string) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  return "png";
}

function normalizeReferenceUrls(values: unknown[], label: string) {
  const urls: string[] = [];
  const errors: string[] = [];
  values.forEach((value, idx) => {
    const raw = typeof value === "string" ? value : "";
    if (!raw.trim()) return;
    try {
      urls.push(normalizeRemoteImageUrl(raw));
    } catch (err: any) {
      errors.push(`${label} ref ${idx + 1}: ${err?.message || "Invalid URL"}`);
    }
  });
  return { urls, errors };
}

async function downloadReferenceAsFile(url: string, index: number) {
  const attempts = [url];
  const encoded = encodeURI(url);
  if (encoded !== url) attempts.push(encoded);
  const storagePath = tryGetStoragePathFromUrl(url);

  let lastError: string | null = null;
  for (const attempt of attempts) {
    try {
      const { bytes, contentType } = await fetchRemoteImageBytes(attempt, {
        timeoutMs: getImageFetchTimeoutMs(),
        maxBytes: getImageFetchMaxBytes(),
      });
      const ext = extFromContentType(contentType);
      return toFile(bytes, `ref-${index + 1}.${ext}`, { type: contentType });
    } catch (err: any) {
      lastError = err?.message || "Image fetch failed";
    }
  }
  if (storagePath) {
    try {
      const { body, contentType } = await downloadStorageObject(storagePath);
      const bytes = Buffer.from(body);
      const ext = extFromContentType(contentType);
      return toFile(bytes, `ref-${index + 1}.${ext}`, { type: contentType });
    } catch (err: any) {
      const storageErr = err?.message || "Storage fetch failed";
      lastError = lastError ? `${lastError}; ${storageErr}` : storageErr;
    }
  }
  throw new Error(
    `Reference image fetch failed at index ${index + 1}${
      lastError ? ` (${lastError})` : ""
    }`
  );
}

function buildReferenceDownloadErrorDetails(params: {
  allRefs: string[];
  downloaded: PromiseSettledResult<Awaited<ReturnType<typeof downloadReferenceAsFile>>>[];
  modelFilesCount: number;
  itemFilesCount: number;
  modelAnchorCount: number;
  itemAnchorCount: number;
}) {
  const { allRefs, downloaded, modelFilesCount, itemFilesCount, modelAnchorCount, itemAnchorCount } =
    params;
  const failedIndexes = downloaded
    .map((result, idx) => ({ result, idx }))
    .filter(({ result }) => result.status === "rejected")
    .map(({ idx }) => idx + 1);
  const malformedCount = allRefs.filter((url) => /%0d|%0a|\r|\n/i.test(String(url || ""))).length;
  const total = allRefs.length;
  const failed = failedIndexes.length;

  const notes: string[] = [];
  if (modelAnchorCount > 0 && modelFilesCount === 0) {
    notes.push("No model reference image could be downloaded.");
  }
  if (itemAnchorCount > 0 && itemFilesCount === 0) {
    notes.push("No item reference image could be downloaded.");
  }
  if (malformedCount > 0) {
    notes.push("Some reference links are malformed (line-break characters detected).");
  }
  if (!notes.length) {
    notes.push("Please re-upload the reference images and try again.");
  }

  return {
    details: `Failed to download ${failed}/${total} reference image(s). ${notes.join(" ")}`,
    failedIndexes,
  };
}

function fallbackGenerateResponse(reason: string) {
  return NextResponse.json({
    imageBase64: FALLBACK_PNG_BASE64,
    degraded: true,
    warning: reason,
  });
}

function isOpenAiAuthError(err: unknown) {
  const status = Number((err as any)?.status || (err as any)?.statusCode || 0);
  const message = String((err as any)?.message || "");
  if (status === 401) return true;
  return /incorrect api key|invalid api key|api key provided/i.test(message);
}

function isOpenAiImagesEditModelError(err: unknown) {
  const status = Number((err as any)?.status || (err as any)?.statusCode || 0);
  const message = String((err as any)?.message || "");
  if (status !== 400) return false;
  return (
    /value must be ['"]dall-e-2['"]/i.test(message) ||
    /invalid value.*model/i.test(message) ||
    /invalid model/i.test(message)
  );
}

// Modern image models (gpt-image-2 and similar) reject prompts longer than
// this many characters with a 400 "string too long" error. We keep a small
// safety margin under the documented 32000 ceiling.
const MODEL_PROMPT_MAX_CHARS = 31800;

// Enforce the model prompt length limit while always preserving the
// server-appended identity/safety/coverage locks (they are non-negotiable).
// Only the client-built portion is trimmed, keeping its head (scene setup) and
// tail (panel-specific locks) and dropping the middle if necessary.
function clampLockedPrompt(
  clientPrompt: string,
  serverLockBlock: string,
  maxLen = MODEL_PROMPT_MAX_CHARS
) {
  const separator = "\n\n";
  const full = `${clientPrompt}${separator}${serverLockBlock}`;
  if (full.length <= maxLen) return { prompt: full, trimmed: false };

  // First try a lossless pass: collapse runs of blank lines and trailing
  // whitespace in the client portion. This often recovers the small overflow
  // (typically a few hundred to ~2000 chars) without dropping any content.
  const compactedClient = clientPrompt
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const compactedFull = `${compactedClient}${separator}${serverLockBlock}`;
  if (compactedFull.length <= maxLen) return { prompt: compactedFull, trimmed: false };

  const reserved = serverLockBlock.length + separator.length;
  const ellipsis = "\n...[prompt trimmed to fit model length limit]...\n";
  const budget = maxLen - reserved;
  // Pathological case: the server lock block alone is near/over the limit.
  // Hard-cap the whole string so we never exceed the API contract.
  if (budget <= ellipsis.length) {
    return { prompt: compactedFull.slice(0, maxLen), trimmed: true };
  }
  const keep = budget - ellipsis.length;
  const headLen = Math.ceil(keep * 0.6);
  const tailLen = keep - headLen;
  const head = compactedClient.slice(0, headLen).trimEnd();
  const tail = compactedClient.slice(compactedClient.length - tailLen).trimStart();
  const trimmedClient = `${head}${ellipsis}${tail}`;
  return { prompt: `${trimmedClient}${separator}${serverLockBlock}`, trimmed: true };
}

// Final hard guard applied at the single point where any prompt is sent to a
// modern image model — covers the main prompt AND the safety-retry prompts
// (which append text to the locked prompt and could otherwise exceed the limit).
function enforcePromptLength(prompt: string, maxLen = MODEL_PROMPT_MAX_CHARS) {
  if (prompt.length <= maxLen) return prompt;
  const compacted = prompt
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (compacted.length <= maxLen) return compacted;
  const ellipsis = "\n...[prompt trimmed to fit model length limit]...\n";
  const keep = maxLen - ellipsis.length;
  if (keep <= 0) return compacted.slice(0, maxLen);
  const headLen = Math.ceil(keep * 0.6);
  const tailLen = keep - headLen;
  const head = compacted.slice(0, headLen).trimEnd();
  const tail = compacted.slice(compacted.length - tailLen).trimStart();
  return `${head}${ellipsis}${tail}`;
}

function compactPromptForDalle2(prompt: string, maxLen = 1000) {
  const normalized = String(prompt || "").replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  // Keep a small suffix from the original prompt where hard locks are often appended.
  const suffixLen = Math.min(320, Math.max(120, Math.floor(maxLen * 0.32)));
  const prefixLen = maxLen - suffixLen - 3;
  const prefix = normalized.slice(0, Math.max(0, prefixLen)).trim();
  const suffix = normalized.slice(Math.max(0, normalized.length - suffixLen)).trim();
  const merged = `${prefix}...${suffix}`;
  return merged.length <= maxLen ? merged : merged.slice(0, maxLen);
}

// Always-on server ceiling: no nudity, and the exact max exposure the brand
// allows. Appended to every generation regardless of item type.
function buildNudityCeilingLock() {
  // Minimal, always-on brand-safety line. Swimwear vs non-swimwear coverage
  // specifics are added conditionally in serverLockBlock, so this stays free of
  // terms that would raise the prompt's moderation score on normal apparel.
  return "BRAND SAFETY (SERVER): professional fashion ecommerce catalog; adult model 25+; keep the model appropriately dressed with storefront-safe, non-suggestive styling.";
}

function buildNonSwimwearCoverageLock(itemType: string) {
  const category = inferItemTypeCategory(itemType);
  const lines: string[] = [
    "NON-SWIMWEAR COVERAGE LOCK (SERVER):",
    "- This request is non-swimwear ecommerce apparel.",
    "- Never render revealing/underwear-like or shirtless styling unless explicitly present in both model and item refs.",
    "- Keep styling strictly product-catalog neutral and fully clothed.",
    "- Preserve non-target outfit parts from references unless item refs explicitly replace them.",
  ];
  if (category === "bottom") {
    lines.push(
      "- Locked item type is BOTTOM (e.g., jeans/pants/shorts): keep a normal opaque top on the model; shirtless torso is forbidden."
    );
  }
  if (category === "top") {
    lines.push(
      "- Locked item type is TOP: keep appropriate bottoms on the model from refs; no underwear-style substitution."
    );
  }
  return lines.join("\n");
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const timer = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getImageTimeoutMs() {
  const rawText = (process.env.OPENAI_IMAGE_TIMEOUT_MS || "").trim();
  if (!rawText) return 120000;
  const raw = Number(rawText);
  if (!Number.isFinite(raw)) return 120000;
  const bounded = Math.max(30000, Math.min(240000, Math.floor(raw)));
  return bounded;
}

type PanelQaInput = {
  panelNumber: number | null;
  panelLabel: string;
  poseA: number | null;
  poseB: number | null;
  modelName: string;
  modelGender: string;
  itemType: string;
};

function isFullBodyPose(gender: string, pose: number | null) {
  if (!Number.isFinite(Number(pose))) return false;
  const p = Number(pose);
  const g = String(gender || "").trim().toLowerCase();
  if (g === "female") {
    return p === 1 || p === 2 || p === 3 || p === 6;
  }
  return p === 1 || p === 2 || p === 4;
}

function isBackFacingPose(gender: string, pose: number | null) {
  if (!Number.isFinite(Number(pose))) return false;
  const p = Number(pose);
  const g = String(gender || "").trim().toLowerCase();
  if (g === "female") {
    return p === 2;
  }
  return p === 4 || p === 7;
}

function inferItemTypeCategory(itemTypeValue: string) {
  const t = String(itemTypeValue || "").trim().toLowerCase();
  if (!t) return "item";
  const has = (...keywords: string[]) => keywords.some((kw) => t.includes(kw));
  if (
    has(
      "full look",
      "full-look",
      "outfit",
      "set",
      "matching set",
      "two piece",
      "two-piece",
      "co-ord",
      "co ord"
    )
  ) {
    return "full-look";
  }
  if (
    has(
      "shirt",
      "tee",
      "t-shirt",
      "tshirt",
      "tank",
      "top",
      "blouse",
      "hoodie",
      "crewneck",
      "sweatshirt",
      "sweater",
      "polo",
      "jersey",
      "vest",
      "cardigan",
      "button-down",
      "button down"
    )
  ) {
    return "top";
  }
  if (
    has(
      "pant",
      "pants",
      "jean",
      "jeans",
      "short",
      "shorts",
      "skirt",
      "legging",
      "jogger",
      "cargo",
      "trouser",
      "bottom"
    )
  ) {
    return "bottom";
  }
  if (has("shoe", "sneaker", "boot", "heel", "sandal", "loafer", "trainer", "footwear")) {
    return "footwear";
  }
  if (has("jacket", "coat", "puffer", "overshirt", "outerwear", "windbreaker", "blazer")) {
    return "outerwear";
  }
  if (
    has(
      "bag",
      "hat",
      "cap",
      "belt",
      "scarf",
      "sock",
      "socks",
      "accessory",
      "jewelry",
      "jewellery",
      "watch",
      "glove",
      "gloves"
    )
  ) {
    return "accessory";
  }
  return "item";
}

function isSwimwearItemType(itemTypeValue: string) {
  const t = String(itemTypeValue || "").trim().toLowerCase();
  if (!t) return false;
  return (
    t.includes("swimwear") ||
    t.includes("swim short") ||
    t.includes("swimshort") ||
    t.includes("swim trunk") ||
    t.includes("swim trunks") ||
    t.includes("bikini") ||
    t.includes("one-piece swimsuit") ||
    t.includes("one piece swimsuit") ||
    t.includes("swimsuit")
  );
}

function getCloseUpCategoryQaRule(itemTypeValue: string) {
  const category = inferItemTypeCategory(itemTypeValue);
  if (category === "top") {
    return "Expected close-up category: TOP only (not shorts/pants/shoes).";
  }
  if (category === "bottom") {
    return "Expected close-up category: BOTTOM only (not tops/shoes).";
  }
  if (category === "footwear") {
    return "Expected close-up category: FOOTWEAR only.";
  }
  if (category === "outerwear") {
    return "Expected close-up category: OUTERWEAR only.";
  }
  if (category === "accessory") {
    return "Expected close-up category: ACCESSORY only.";
  }
  if (category === "full-look") {
    return "Expected close-up category: one hero detail from the locked full look.";
  }
  return "Expected close-up category: must match the exact section 0.5 item type.";
}

function hasPanel3CloseUpSubjectLock(panelQa: PanelQaInput) {
  const g = String(panelQa.modelGender || "").trim().toLowerCase();
  const panelNumber = Number(panelQa.panelNumber);
  const rightPose = Number(panelQa.poseB);
  if (!Number.isFinite(panelNumber) || !Number.isFinite(rightPose)) return false;
  if (g === "female") {
    return panelNumber === 3 && rightPose === 5;
  }
  return panelNumber === 3 && rightPose === 6;
}

function sanitizeText(value: unknown, maxLen = 180) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLen);
}

function toIntOrNull(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function normalizePanelQa(value: any): PanelQaInput {
  return {
    panelNumber: toIntOrNull(value?.panelNumber),
    panelLabel: sanitizeText(value?.panelLabel, 120),
    poseA: toIntOrNull(value?.poseA),
    poseB: toIntOrNull(value?.poseB),
    modelName: sanitizeText(value?.modelName, 120),
    modelGender: sanitizeText(value?.modelGender, 32).toLowerCase(),
    itemType: sanitizeText(value?.itemType, 120),
  };
}

function buildServerIdentityLockPrompt(panelQa: PanelQaInput) {
  const modelName = panelQa.modelName || "locked model";
  const modelGender = panelQa.modelGender || "model";
  const lockedItemType = panelQa.itemType || "apparel item";
  const backLockActive =
    isBackFacingPose(panelQa.modelGender, panelQa.poseA) ||
    isBackFacingPose(panelQa.modelGender, panelQa.poseB);
  return [
    "SERVER-ENFORCED IDENTITY LOCK (NON-NEGOTIABLE):",
    `- Use ONLY MODEL reference images for person identity (${modelName}, ${modelGender}).`,
    "- Keep the same exact facial geometry from model refs: eye shape/spacing, nose bridge/tip, lip contour, jawline, cheek structure, brow shape, and hairline.",
    "- Keep the same exact skin tone and undertone from model refs.",
    "- Never lighten, darken, recolor, tan, bleach, or stylize skin tone away from model refs.",
    "- Never blend identity traits from item-reference humans or any unrelated person.",
    "- If identity fidelity conflicts with style, prioritize identity fidelity.",
    "SERVER-ENFORCED BACKGROUND LOCK (NON-NEGOTIABLE):",
    "- Use seamless pure white studio background only (#FFFFFF).",
    "- No pink tint, warm tint, cream cast, gray cast, gradient, vignette, texture, or wrinkles.",
    "- Keep the exact same white background tone and lighting across all generated panels.",
    "- Keep only a very faint neutral contact shadow on floor; no colored bounce light.",
    "SERVER-ENFORCED ITEM FIDELITY LOCK (NON-NEGOTIABLE):",
    `- Locked item type from section 0.5: "${lockedItemType}".`,
    "- Prioritize garment details that match this locked item type.",
    "- If item refs include a full look, preserve the total outfit structure (top, bottom, footwear, accessories) from that full look.",
    "- If both full-look and isolated item refs are provided, use isolated refs only to refine the locked item details while keeping non-target full-look pieces unchanged.",
    "- Garment design must match item-reference photos exactly.",
    "- Never invent, replace, remove, recolor, or restyle logos/graphics/prints/embroidery/patches.",
    "- If an item ref shows a back graphic/print, preserve that exact back design (position, scale, colors, and style).",
    "- If refs do not show a clear back graphic, keep back surface solid/clean in item color only.",
    "- GLOBAL BACK-DESIGN HARD LOCK (ALL GENDERS, ALL PANELS, ALL POSES): never invent or redesign back graphics.",
    ...(backLockActive
      ? [
          "BACK-VIEW STRICT LOCK ACTIVE:",
          "- At least one active pose is back-facing in this panel.",
          "- Back-facing frame must reflect the exact back design from refs; no substitutions.",
        ]
      : []),
  ].join("\n");
}

function extractOpenAiOutputText(result: any) {
  const direct = typeof result?.output_text === "string" ? result.output_text.trim() : "";
  if (direct) return direct;
  const chunks: string[] = [];
  const output = Array.isArray(result?.output) ? result.output : [];
  for (const row of output) {
    const content = Array.isArray(row?.content) ? row.content : [];
    for (const part of content) {
      if (typeof part?.text === "string" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }
  return chunks.join("\n").trim();
}

function parseJsonObjectFromText(text: string): Record<string, any> | null {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
      const parsed = JSON.parse(raw.slice(first, last + 1));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
}

function asStrictBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : null;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (["true", "yes", "y", "pass", "ok"].includes(v)) return true;
  if (["false", "no", "n", "fail"].includes(v)) return false;
  return null;
}

function normalizeReasons(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => Boolean(v))
    .slice(0, 8);
}

async function runPanelComplianceCheck(args: {
  openai: OpenAI;
  imageBase64: string;
  modelRefs: string[];
  itemRefs: string[];
  panelQa: PanelQaInput;
  timeoutMs: number;
}) {
  const qaModel = (process.env.OPENAI_IMAGE_QA_MODEL || "gpt-4o-mini").trim() || "gpt-4o-mini";
  const panelName =
    args.panelQa.panelLabel ||
    (args.panelQa.panelNumber ? `Panel ${args.panelQa.panelNumber}` : "Panel");
  const hasFullBodyActivePose =
    isFullBodyPose(args.panelQa.modelGender, args.panelQa.poseA) ||
    isFullBodyPose(args.panelQa.modelGender, args.panelQa.poseB);
  const hasBackFacingActivePose =
    isBackFacingPose(args.panelQa.modelGender, args.panelQa.poseA) ||
    isBackFacingPose(args.panelQa.modelGender, args.panelQa.poseB);
  const swimwearActive = isSwimwearItemType(args.panelQa.itemType);
  const closeUpSubjectLockActive = hasPanel3CloseUpSubjectLock(args.panelQa);
  const closeUpCategoryQaRule = getCloseUpCategoryQaRule(args.panelQa.itemType);
  const userContent: any[] = [
    {
      type: "input_text",
      text: [
        "Expected lock context:",
        `- Panel: ${panelName}`,
        `- Left pose: ${args.panelQa.poseA ?? "unknown"}`,
        `- Right pose: ${args.panelQa.poseB ?? "unknown"}`,
        `- Model: ${args.panelQa.modelName || "unknown"} (${args.panelQa.modelGender || "unknown"})`,
        `- Item type: ${args.panelQa.itemType || "apparel item"}`,
        ...(hasFullBodyActivePose
          ? [
              swimwearActive
                ? "- Swimwear footwear lock active: full-body poses may use flip-flops/water-shoes, or naturally uncovered feet."
                : "- Footwear hard lock active: full-body poses must include visible shoes. Barefoot is forbidden.",
            ]
          : []),
        ...(closeUpSubjectLockActive
          ? [
              "- Close-up subject lock active for this panel.",
              `- Right-side close-up must match section 0.5 item type exactly: "${args.panelQa.itemType || "apparel item"}".`,
              `- ${closeUpCategoryQaRule}`,
              "- Right-side close-up must preserve visible brand label/logo/patch details from item refs (same position, shape, and color family).",
            ]
          : []),
        ...(hasBackFacingActivePose
          ? [
              "- Back-view strict lock active for this panel.",
              "- Any back-facing frame must keep the exact back design from item refs (no invented/changed back graphics).",
              "- If item refs do not clearly show a back design, any added back graphic should fail.",
            ]
          : []),
        "- Identity fidelity lock active: generated person must match MODEL refs for facial geometry and skin tone/undertone.",
        "- Background lock active: seamless pure white studio background only (#FFFFFF), no tint.",
        "- 3:4 center-crop lock active: each left/right pose should be centered in its half so a center 3:4 crop keeps key subject details intact.",
      ].join("\n"),
    },
    { type: "input_text", text: "MODEL reference images (identity lock):" },
    ...args.modelRefs.slice(0, 4).map((url) => ({ type: "input_image", image_url: url })),
    { type: "input_text", text: "ITEM reference images (outfit lock):" },
    ...args.itemRefs.map((url) => ({ type: "input_image", image_url: url })),
    { type: "input_text", text: "Generated panel to audit:" },
    { type: "input_image", image_url: `data:image/png;base64,${args.imageBase64}` },
    {
      type: "input_text",
      text: [
        "Return JSON only with these keys:",
        "{",
        '  "pass": boolean,',
        '  "reasons": string[]',
        "}",
        swimwearActive
          ? "For swimwear item type, uncovered feet are allowed; fail only if output is suggestive or mismatched to refs."
          : "If any full-body pose appears barefoot or socks-only, set pass=false.",
        "If close-up subject lock is active and the right close-up clearly focuses on a different item type/category than the locked section 0.5 item type, set pass=false.",
        "If close-up subject lock is active and visible label/logo/patch details in item refs are missing/replaced/relocated in the right close-up, set pass=false.",
        "If back-view strict lock is active and back-facing design does not clearly match item refs, set pass=false.",
        "If either side appears significantly off-center such that a center 3:4 crop would cut key model/item content, set pass=false.",
        "If item type is non-swimwear bottom (jeans/pants/shorts) and output shows shirtless/bare torso styling, set pass=false.",
        "If the output shows any nudity or partial nudity, set pass=false.",
        "If exposure exceeds standard commercial swimwear coverage (women beyond a regular bikini/one-piece, men beyond swim trunks), or a non-swimwear item is shown without a proper top, set pass=false.",
        "If facial geometry or skin tone/undertone clearly drifts from MODEL refs, set pass=false.",
        "If background is not seamless pure white (any pink/warm/cream/gray tint, gradient, vignette, texture, or colored cast), set pass=false.",
        "Set pass=false only when you are clearly confident this output violates model/item/pose lock.",
        "If uncertain, set pass=true and include reason that result is inconclusive.",
      ].join("\n"),
    },
  ];

  const qaAttempts = Math.max(1, Number(process.env.PANEL_QA_ATTEMPTS) || 2);
  let qaResponse: any = null;
  let qaCallErr: any = null;
  for (let attempt = 0; attempt < qaAttempts; attempt += 1) {
    try {
      qaResponse = await withTimeout(
        args.openai.responses.create({
          model: qaModel,
          temperature: 0,
          max_output_tokens: 260,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text:
                    "You are a strict pass/fail QA gate for fashion ecommerce panel outputs. " +
                    "Fail the audit if model identity is not clearly from model refs, item/outfit is not clearly from item refs, " +
                    "or expected pose pairing is not respected. Treat face-geometry drift and skin-tone drift from model refs as identity failures. " +
                    "Also fail any non-pure-white/tinted background. No prose. Return JSON only.",
                },
              ],
            },
            {
              role: "user",
              content: userContent,
            },
          ],
        }),
        Math.max(30000, Math.min(args.timeoutMs, 90000)),
        "OpenAI panel compliance check"
      );
      break;
    } catch (e: any) {
      qaCallErr = e;
      qaResponse = null;
    }
  }
  if (!qaResponse) {
    return {
      decisive: false,
      pass: true,
      unavailable: true,
      reasons: [`Compliance check unavailable: ${qaCallErr?.message || "unknown error"}`],
      raw: "",
    };
  }

  const raw = extractOpenAiOutputText(qaResponse).slice(0, 3000);
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed) {
    return {
      decisive: false,
      pass: true,
      unavailable: false,
      reasons: ["Compliance check returned unparsable output."],
      raw,
    };
  }

  const passFlag = asStrictBoolean(parsed.pass);
  if (passFlag === null) {
    return {
      decisive: false,
      pass: true,
      unavailable: false,
      reasons: ["Compliance check missing boolean pass field."],
      raw,
    };
  }
  const reasons = normalizeReasons(parsed.reasons);
  return {
    decisive: true,
    pass: passFlag === true,
    unavailable: false,
    reasons: reasons.length ? reasons : passFlag ? [] : ["Compliance check failed."],
    raw,
  };
}

export async function POST(req: NextRequest) {
  try {
    // WMS auth: authenticated admin session (replaces carbon-gen cookie auth).
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const authPool = getPool();
    if (!authPool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const denied = await requireSessionScopes(authPool, session, [SCOPES.ADMIN]);
    if (denied) return denied;

    const key = getClientKey(req);
    const rate: any = await checkGenerateRateLimit(key);
    if (!rate.success) {
      if (rate.error) {
        return NextResponse.json({ error: rate.error }, { status: 500 });
      }
      return NextResponse.json(
        { error: "Too many requests. Please try again later." },
        {
          status: 429,
          headers:
            typeof rate.reset === "number"
              ? { "RateLimit-Reset": String(rate.reset) }
              : undefined,
        }
      );
    }

    const { prompt, size, modelRefs, itemRefs, panelQa, variationStrength, variationSeed } =
      await req.json();
    const normalizedPanelQa = normalizePanelQa(panelQa);
    // Pose/expression variation: rotate by a per-generation seed so consecutive
    // shots never collapse to the same default pose/face. Falls back to a
    // time-derived seed when the client doesn't send one (older builders).
    const resolvedVariationSeed = Number.isFinite(Number(variationSeed))
      ? Math.floor(Number(variationSeed))
      : Math.floor(Date.now() / 1000);

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const modelRefValues = Array.isArray(modelRefs) ? modelRefs : [];
    const itemRefValues = Array.isArray(itemRefs) ? itemRefs : [];
    const modelRefNormalization = normalizeReferenceUrls(modelRefValues, "Model");
    const itemRefNormalization = normalizeReferenceUrls(itemRefValues, "Item");
    const normalizedModelRefs = modelRefNormalization.urls;
    const normalizedItemRefs = itemRefNormalization.urls;
    const refErrors = [...modelRefNormalization.errors, ...itemRefNormalization.errors];
    if (refErrors.length) {
      return NextResponse.json(
        {
          error: "Invalid or blocked reference image URLs.",
          details: refErrors.join(" | "),
        },
        { status: 400 }
      );
    }

    if (!normalizedModelRefs.length) {
      return NextResponse.json(
        { error: "Missing model reference images" },
        { status: 400 }
      );
    }
    if (!normalizedItemRefs.length) {
      return NextResponse.json(
        { error: "Missing item reference images" },
        { status: 400 }
      );
    }
    if (normalizedModelRefs.length < 3) {
      return NextResponse.json(
        {
          error:
            "Locked model is under-specified. Upload/select at least 3 model reference images before generating.",
        },
        { status: 400 }
      );
    }
    if (!normalizedPanelQa.modelName || !normalizedPanelQa.modelGender) {
      return NextResponse.json(
        {
          error:
            "Missing locked model context for generation. Please reselect your model and retry.",
        },
        { status: 400 }
      );
    }
    if (normalizedPanelQa.poseA === null || normalizedPanelQa.poseB === null) {
      return NextResponse.json(
        {
          error: "Missing panel pose lock context. Please retry from the panel controls.",
        },
        { status: 400 }
      );
    }

    type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
    const allowedSizes = new Set<ImageSize>(["1024x1024", "1536x1024", "1024x1536"]);
    const finalSize =
      typeof size === "string" && allowedSizes.has(size as ImageSize)
        ? (size as ImageSize)
        : ("1536x1024" as ImageSize);

    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
      return fallbackGenerateResponse("OPENAI_API_KEY is not set. Returned local fallback image.");
    }

    const openai = new OpenAI({ apiKey });
    const imageTimeoutMs = getImageTimeoutMs();
    const imageModel = (process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5").trim() || "gpt-image-1.5";
    // Render quality for gpt-image-* edits (low | medium | high | auto). Pinned
    // high; env-overridable without a redeploy.
    const imageQuality = (process.env.OPENAI_IMAGE_QUALITY || "high").trim() || "high";
    const swimwearActive = isSwimwearItemType(normalizedPanelQa.itemType);
    const serverIdentityLockPrompt = buildServerIdentityLockPrompt(normalizedPanelQa);
    const poseVariationDirective = buildPoseVariationDirective({
      modelGender: normalizedPanelQa.modelGender,
      poseA: normalizedPanelQa.poseA,
      poseB: normalizedPanelQa.poseB,
      strength: normalizeStrength(variationStrength),
      seed: resolvedVariationSeed,
    });
    const serverLockBlock = [
      serverIdentityLockPrompt,
      buildNudityCeilingLock(),
      ...(poseVariationDirective ? [poseVariationDirective] : []),
      ...(swimwearActive
        ? [
            "SWIMWEAR SAFETY LOCK (SERVER):",
            "Professional ecommerce swimwear catalog image only.",
            "Adult model (25+), neutral posture, non-suggestive composition.",
            "Standard commercial swimwear coverage only (regular bikini/one-piece for women; swim trunks for men); keep it consistent with a mainstream retail catalog.",
            "Focus on garment fit, color, material, and product details.",
          ]
        : [buildNonSwimwearCoverageLock(normalizedPanelQa.itemType)]),
    ].join("\n");
    const clamped = clampLockedPrompt(prompt, serverLockBlock);
    const lockedPrompt = clamped.prompt;
    if (clamped.trimmed) {
      console.warn(
        `[generate] prompt exceeded ${MODEL_PROMPT_MAX_CHARS} chars (client portion ${prompt.length}); trimmed client prompt to fit while preserving server locks.`
      );
    }

    // Keep model identity anchors bounded; include all item refs provided by section 0.5.
    const modelAnchors = normalizedModelRefs.slice(0, 6);
    const itemAnchors = normalizedItemRefs;

    const allRefs = [...modelAnchors, ...itemAnchors];
    const downloaded = await Promise.allSettled(
      allRefs.map((url, idx) => downloadReferenceAsFile(url, idx))
    );

    const referenceFiles = downloaded
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof downloadReferenceAsFile>>> => r.status === "fulfilled")
      .map((r) => r.value);
    const modelFilesCount = downloaded
      .slice(0, modelAnchors.length)
      .filter((r) => r.status === "fulfilled").length;
    const itemFilesCount = downloaded
      .slice(modelAnchors.length)
      .filter((r) => r.status === "fulfilled").length;

    if (!referenceFiles.length || modelFilesCount === 0 || itemFilesCount === 0) {
      const summary = buildReferenceDownloadErrorDetails({
        allRefs,
        downloaded,
        modelFilesCount,
        itemFilesCount,
        modelAnchorCount: modelAnchors.length,
        itemAnchorCount: itemAnchors.length,
      });
      return NextResponse.json(
        {
          error: "Unable to download required reference images.",
          details: summary.details,
          failedIndexes: summary.failedIndexes,
        },
        { status: 400 }
      );
    }
    if (modelFilesCount < 3) {
      return NextResponse.json(
        {
          error:
            "Locked model is under-specified after download. At least 3 model references must be successfully readable.",
        },
        { status: 400 }
      );
    }

    let b64: string | null = null;
    // Only the configured model — never silently substitute a different (paid)
    // model. If it can't generate, we surface an error rather than charge for and
    // return an image the operator didn't ask for.
    const modelCandidates = [imageModel];
    async function runImageEditWithFallback(params: {
      prompt: string;
      inputFidelity?: "high";
      timeoutLabel: string;
    }) {
      let lastErr: any = null;
      for (const modelName of modelCandidates) {
        try {
          const request: any = {
            model: modelName,
            // OpenAI edits for dall-e-2 expects a single file (not an array).
            image: modelName === "dall-e-2" ? referenceFiles[0] : referenceFiles,
            prompt:
              modelName === "dall-e-2"
                ? compactPromptForDalle2(params.prompt, 1000)
                : enforcePromptLength(params.prompt),
            // dall-e-2 supports square edit sizes only.
            size: modelName === "dall-e-2" ? "1024x1024" : finalSize,
          };
          // input_fidelity is supported by gpt-image-1 / gpt-image-1.5 only.
          // dall-e-2 and gpt-image-2 hard-fail (400) if it's sent, so gate it.
          const supportsInputFidelity =
            modelName !== "dall-e-2" && !modelName.startsWith("gpt-image-2");
          if (params.inputFidelity && supportsInputFidelity) {
            request.input_fidelity = params.inputFidelity;
          }
          // gpt-image-* supports an explicit render quality; dall-e-2 does not.
          if (modelName !== "dall-e-2") {
            request.quality = imageQuality;
          }
          const edited = await withTimeout(
            openai.images.edit(request),
            imageTimeoutMs,
            params.timeoutLabel
          );
          return edited;
        } catch (err: any) {
          lastErr = err;
          const canFallbackToDalle2 =
            modelName !== "dall-e-2" &&
            modelCandidates.includes("dall-e-2") &&
            isOpenAiImagesEditModelError(err);
          if (canFallbackToDalle2) continue;
          throw err;
        }
      }
      throw lastErr || new Error("OpenAI image generation failed");
    }
    try {
      // IMPORTANT: do NOT set input_fidelity here. On gpt-image edits it forces
      // faithful reproduction of the faces in ALL input images — including any
      // person wearing the garment in the ITEM references — which overrides the
      // prompt's "item refs are product-only" rule and makes the output copy the
      // wrong person. Identity is held by the prompt's model-ref identity locks.
      const edited = await runImageEditWithFallback({
        prompt: lockedPrompt,
        timeoutLabel: "OpenAI image generation",
      });
      b64 = edited.data?.[0]?.b64_json ?? null;
    } catch (err: any) {
      const code = String(err?.code || "");
      const type = String(err?.type || "");
      const message = String(err?.message || "");
      if (isOpenAiAuthError(err)) {
        return NextResponse.json(
          {
            error:
              "OpenAI authentication failed on server. Update OPENAI_API_KEY in production env and redeploy.",
          },
          { status: 500 }
        );
      }
      const looksLikeSexualBlock =
        code === "moderation_blocked" ||
        type === "image_generation_user_error" ||
        /safety_violations=\[sexual\]/i.test(message);
      const requestId = err?.requestID || err?.headers?.get?.("x-request-id") || null;

      // FAIL CLOSED. Never auto-retry with a modified prompt and never substitute
      // a different model — either would charge OpenAI for an image the operator
      // did not ask for. Return a clear error; nothing was generated.
      if (looksLikeSexualBlock) {
        return NextResponse.json(
          {
            error: {
              type: "policy_refusal",
              code: code || "moderation_blocked",
              message:
                "Blocked by safety moderation for this reference set — nothing was generated. Adjust the crop / reference mix, or use neutral front/back product shots, and try again.",
              requestId,
            },
          },
          { status: 403 }
        );
      }
      return NextResponse.json(
        {
          error: {
            type: "generation_failed",
            code: code || type || "unknown",
            message:
              (err instanceof Error ? err.message : "OpenAI image generation failed") +
              " — nothing usable was generated.",
            requestId,
          },
        },
        { status: 502 }
      );
    }


    if (!b64) {
      return NextResponse.json(
        {
          error: {
            type: "generation_failed",
            code: "no_image",
            message: "The provider returned no image. Nothing usable was generated.",
          },
        },
        { status: 502 }
      );
    }

    const strictLocksEnabled =
      (process.env.STRICT_PANEL_LOCKS || "true").trim().toLowerCase() !== "false";
    // When QA can't reach a confident verdict (inconclusive, or the QA call itself
    // failed/timed out), fail open by default: serve the already-generated image
    // instead of discarding it. Set PANEL_QA_FAIL_OPEN=false to hard-block instead.
    const qaFailOpen =
      (process.env.PANEL_QA_FAIL_OPEN || "true").trim().toLowerCase() !== "false";
    if (strictLocksEnabled) {
      let qa: any;
      try {
        qa = await runPanelComplianceCheck({
          openai,
          imageBase64: b64,
          modelRefs: modelAnchors,
          itemRefs: itemAnchors,
          panelQa: normalizedPanelQa,
          timeoutMs: imageTimeoutMs,
        });
      } catch (qaErr: any) {
        qa = {
          decisive: false,
          pass: true,
          unavailable: true,
          reasons: [`Compliance check threw: ${qaErr?.message || "unknown error"}`],
        };
      }
      if (qa.decisive && !qa.pass) {
        // Confident lock violation — keep blocking.
        return NextResponse.json(
          {
            error: {
              type: "lock_violation",
              code: "identity_or_item_lock_failed",
              message:
                "Generated output failed identity/item lock QA. Regenerate this panel with stricter matching.",
              reasons: qa.reasons,
            },
          },
          { status: 422 }
        );
      }
      if (!qa.decisive && !qaFailOpen) {
        // Strict mode: block when QA could not confidently clear the image.
        const unavailable = qa.unavailable === true;
        return NextResponse.json(
          {
            error: {
              type: "lock_violation",
              code: unavailable ? "qa_unavailable_blocked" : "qa_inconclusive_blocked",
              message: unavailable
                ? "Generated output was blocked because lock QA was unavailable. Please retry this panel."
                : "Generated output was blocked because compliance QA was inconclusive. Regenerate this panel.",
              reasons: qa.reasons,
            },
          },
          { status: unavailable ? 503 : 422 }
        );
      }
      if (!qa.decisive) {
        console.warn(
          `[generate] Panel QA non-decisive (${qa.unavailable ? "unavailable" : "inconclusive"}); serving image (fail-open).`,
          qa.reasons
        );
      }
    }
    return NextResponse.json({ imageBase64: b64 });
  } catch (err: unknown) {
    console.error("Generate failed:", err);
    if (isOpenAiAuthError(err)) {
      return NextResponse.json(
        {
          error:
            "OpenAI authentication failed on server. Update OPENAI_API_KEY in production env and redeploy.",
        },
        { status: 500 }
      );
    }
    const reason = err instanceof Error ? err.message : "Generate failed";
    return fallbackGenerateResponse(reason);
  }
}
