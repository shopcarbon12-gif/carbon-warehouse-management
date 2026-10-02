/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI, { toFile } from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { LOCK_TEXT_MAX_BYTES, parseSpecBackState, specListsBackDesign, withCanonicalBackLine } from "@/lib/studio-item-spec";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  recordStudioGeneration,
  updateStudioGenerationQa,
  type StudioGenerationLog,
} from "@/lib/server/studio-generation-log";
import { isValidQaId, runPanelQa } from "@/lib/server/panel-qa-store";
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
import { isValidJobId, runGenerateJob } from "@/lib/server/generate-jobs";

const FALLBACK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAIAAAB7GkOtAAAFx0lEQVR42u3UwQkAIBDAMHX/nc8lBK4jUZBkn2tmdgDg53YHAH4MIAgQCBAECAQIAgQCBAECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIBggCBAEEAQYBAgCBAIEAQIBAgECAIEAQQBAgECAIEAgQBAgECAQIhD8eQ9JCmqo2AAAAAElFTkSuQmCC";

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

/** Downloaded reference: the upload File for images.edit AND a data URL for
 * the QA vision pass (OpenAI cannot fetch our private R2 endpoint URLs, which
 * had left the compliance gate permanently "unavailable" → fail-open). */
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
      return {
        file: await toFile(bytes, `ref-${index + 1}.${ext}`, { type: contentType }),
        dataUrl: `data:${contentType || "image/png"};base64,${Buffer.from(bytes).toString("base64")}`,
      };
    } catch (err: any) {
      lastError = err?.message || "Image fetch failed";
    }
  }
  if (storagePath) {
    try {
      const { body, contentType } = await downloadStorageObject(storagePath);
      const bytes = Buffer.from(body);
      const ext = extFromContentType(contentType);
      return {
        file: await toFile(bytes, `ref-${index + 1}.${ext}`, { type: contentType }),
        dataUrl: `data:${contentType || "image/png"};base64,${bytes.toString("base64")}`,
      };
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

// Modern image models (gpt-image-2 and similar) reject prompts longer than
// this many characters with a 400 "string too long" error. We keep a small
// safety margin under the documented 32000 ceiling.
const MODEL_PROMPT_MAX_CHARS = 31800;

// OpenAI's 32000 limit is NOT JavaScript's UTF-16 `.length`: prompts full of
// "—", "×", "➘", "…" (pose libraries, the item spec) measured under the cap in
// JS yet were rejected with 400 "string too long" (seen on Panel 4,
// 2026-08-26). Measure UTF-8 bytes — stricter than any counting OpenAI uses.
const promptLen = (s: string) => Buffer.byteLength(s, "utf8");
/** Hard byte cut that never splits a multi-byte character. */
function cutToBytes(s: string, maxBytes: number) {
  if (promptLen(s) <= maxBytes) return s;
  let out = s;
  while (promptLen(out) > maxBytes) out = out.slice(0, Math.max(0, out.length - Math.ceil((promptLen(out) - maxBytes) / 2) - 1));
  return out;
}

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
  if (promptLen(full) <= maxLen) return { prompt: full, trimmed: false };

  // First try a lossless pass: collapse runs of blank lines and trailing
  // whitespace in the client portion. This often recovers the small overflow
  // (typically a few hundred to ~2000 chars) without dropping any content.
  const compactedClient = clientPrompt
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const compactedFull = `${compactedClient}${separator}${serverLockBlock}`;
  if (promptLen(compactedFull) <= maxLen) return { prompt: compactedFull, trimmed: false };

  const reserved = promptLen(serverLockBlock) + separator.length;
  const ellipsis = "\n...[prompt trimmed to fit model length limit]...\n";
  let budget = maxLen - reserved;
  // Pathological case: the server lock block alone is near/over the limit.
  // Hard-cap the whole string so we never exceed the API contract.
  if (budget <= ellipsis.length) {
    return { prompt: cutToBytes(compactedFull, maxLen), trimmed: true };
  }
  // Byte budget → character slices; shrink until the UTF-8 size fits.
  for (let attempt = 0; attempt < 8; attempt++) {
    const keep = budget - ellipsis.length;
    const headLen = Math.ceil(keep * 0.6);
    const tailLen = keep - headLen;
    const head = compactedClient.slice(0, headLen).trimEnd();
    const tail = compactedClient.slice(Math.max(0, compactedClient.length - tailLen)).trimStart();
    const candidate = `${head}${ellipsis}${tail}${separator}${serverLockBlock}`;
    if (promptLen(candidate) <= maxLen) return { prompt: candidate, trimmed: true };
    budget = Math.floor(budget * 0.9);
  }
  return { prompt: cutToBytes(compactedFull, maxLen), trimmed: true };
}

// Final hard guard applied at the single point where any prompt is sent to a
// modern image model — covers the main prompt AND the safety-retry prompts
// (which append text to the locked prompt and could otherwise exceed the limit).
function enforcePromptLength(prompt: string, maxLen = MODEL_PROMPT_MAX_CHARS) {
  if (promptLen(prompt) <= maxLen) return prompt;
  const compacted = prompt
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (promptLen(compacted) <= maxLen) return compacted;
  const ellipsis = "\n...[prompt trimmed to fit model length limit]...\n";
  let keep = maxLen - ellipsis.length;
  if (keep <= 0) return cutToBytes(compacted, maxLen);
  for (let attempt = 0; attempt < 8; attempt++) {
    const headLen = Math.ceil(keep * 0.6);
    const tailLen = keep - headLen;
    const head = compacted.slice(0, headLen).trimEnd();
    const tail = compacted.slice(Math.max(0, compacted.length - tailLen)).trimStart();
    const candidate = `${head}${ellipsis}${tail}`;
    if (promptLen(candidate) <= maxLen) return candidate;
    keep = Math.floor(keep * 0.9);
  }
  return cutToBytes(compacted, maxLen);
}


/**
 * Brand safety, once. The only place the prompt says "adult, 25+" and the only
 * place it says what coverage means for this item type. It used to be said in
 * eleven places across client and server, in eleven wordings.
 */
function buildBrandSafetyLock(itemType: string) {
  const swim = isSwimwearItemType(itemType);
  const category = inferItemTypeCategory(itemType);
  const coverage = swim
    ? "This item is swimwear: standard commercial swimwear coverage only (a regular bikini or one-piece for women, swim shorts / trunks for men), neutral posture, mainstream retail catalog presentation."
    : category === "bottom"
      ? "The model is fully clothed in normal opaque garments — a normal opaque top stays on; no shirtless torso, no underwear-style styling."
      : category === "top"
        ? "The model is fully clothed in normal opaque garments — appropriate bottoms from the references stay on; no underwear-style substitution."
        : "The model is fully clothed in normal opaque garments; no shirtless or underwear-style styling.";
  return `BRAND SAFETY: professional fashion ecommerce catalog; the model is an adult, 25 or older; storefront-safe, non-suggestive composition and neutral camera angle. ${coverage}`;
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
  // Word-start matches (mirrors lib/panelGeneration.ts): plain substrings made
  // "sunset tee" a full look and "overshirt" a top.
  const has = (...keywords: string[]) => keywords.some((kw) => new RegExp(`\\b${kw}`).test(t));
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

/**
 * The construction details that decide whether a shot of THIS garment type is
 * usable. The item type is not a label on the run — it names the product the
 * photographs exist to sell, so its own details are the ones that must survive
 * every pose, and a generic "keep the garment accurate" line does not tell the
 * model which details those are.
 *
 * Deliberately short: the prompt is already close to its byte ceiling, so each
 * entry is the handful of features a buyer actually inspects.
 */
function itemTypeFocusLine(itemType: string): string {
  const t = (itemType || "").toLowerCase();
  // Word-start matches, most specific category first. Substring matching in
  // bottoms-first order sent "swim shorts" and "short sleeve shirt" down the
  // jeans branch (both contain "short"), so a tee was told to keep its
  // whiskering and front rise.
  const has = (...words: string[]) => words.some((w) => new RegExp(`\\b${w}`, "i").test(t));

  let details: string;
  if (has("swim", "bikini", "trunk", "boardshort")) {
    details =
      "cut and coverage, strap or waistband construction, seams and binding, ties or clasps, and any logo at its exact size and position";
  } else if (has("shoe", "sneaker", "boots?\\b", "sandal", "loafer", "heel", "flip.?flop")) {
    details = "silhouette, upper panels and stitching, laces and eyelets, sole profile and colour blocking, logo placement";
  } else if (has("bag", "belt", "hat", "caps?\\b", "accessor", "scarf", "sock")) {
    details = "shape and proportions, hardware, straps or closures, stitching, material grain, logo placement";
  } else if (has("jacket", "coat", "blazer", "hoodie", "sweatshirt", "outerwear", "puffer", "overshirt", "windbreaker")) {
    details =
      "collar or hood shape, closure (zip teeth/buttons/snaps), shoulder seams and fit, sleeve length and cuff finish, pocket type and placement, hem and drawcords, lining or trims where visible, and any print, text or graphic (chest, back, sleeve) at its exact size, position and print effect";
  } else if (has("dress", "skirt", "jumpsuit", "romper")) {
    details =
      "neckline and strap construction, waist seam and shaping, closure, length and hem, pleats/gathers/slits, and any print or text at its exact size and position";
  } else if (has("tee", "t-shirt", "tshirt", "shirt", "top", "tank", "blouse", "polo", "sweater", "knit", "crewneck", "jersey")) {
    details =
      "neckline shape and rib, shoulder seam placement and drop, sleeve length and cuff, body width and length, hem finish, and any print, text or graphic at its exact size, position and print effect";
  } else if (has("jean", "denim", "pant", "trouser", "chino", "cargo", "shorts", "jogger", "legging", "sweatpant")) {
    details =
      "waistband height and closure (button/zip/rivets), belt loops, front rise, pocket shape and placement (front, coin, back), yoke and back-pocket stitching, wash and fade map, whiskering, distressing and rips exactly where the references show them, leg shape and opening, hem finish and length";
  } else {
    details =
      "seams, closures, pockets, hardware, trims, material and texture, and any print, text or logo at its exact size and position";
  }

  return (
    `ITEM FOCUS — this shoot exists to sell the "${itemType || "apparel item"}". ` +
    `It is the subject of every frame: keep it unobstructed, well lit, and rendered so a buyer can inspect it. ` +
    `Its construction is the priority — ${details}. ` +
    `Other pieces in the look stay exactly as the references show them, but they are context; never let styling, a pose, or another garment hide, crop or soften the ${itemType || "item"}.`
  );
}

/** The garment's back, resolved for this run — see lib/studio-item-spec.ts.
 *  `photo`: a Back photo is attached but the analysis never described it (it
 *  failed to load there, or the spec predates the BACK line) — the photo is
 *  the authority, not a guess either way. */
type BackState = "present" | "absent" | "unknown" | "photo";

/** "RIGHT Pose 4" / "LEFT Pose 7 and RIGHT Pose 2" — the back-facing frames of
 *  THIS panel, by side, so the back rule can never be read as "turn a
 *  front-facing pose around". */
function backFacingFramesLabel(panelQa: PanelQaInput): string {
  const parts: string[] = [];
  if (isBackFacingPose(panelQa.modelGender, panelQa.poseA)) parts.push(`LEFT Pose ${panelQa.poseA}`);
  if (isBackFacingPose(panelQa.modelGender, panelQa.poseB)) parts.push(`RIGHT Pose ${panelQa.poseB}`);
  return parts.join(" and ");
}

/**
 * Everything the server states exactly once, ahead of the view map and spec:
 * who the person is (by attached image index, not by description), the
 * background, and which details of this item type decide the shot.
 */
function buildServerLockPrompt(panelQa: PanelQaInput, modelCount: number) {
  const modelName = panelQa.modelName || "the locked model";
  const modelGender = panelQa.modelGender || "model";
  const lockedItemType = panelQa.itemType || "apparel item";
  const modelRange = modelCount === 1 ? "image 1" : `images 1–${modelCount}`;
  return [
    `IDENTITY: the person in every frame is ${modelName} (${modelGender}) — exactly the person in attached ${modelRange}, the MODEL references: same face geometry (eye shape and spacing, nose, lips, jawline, cheeks, brows), same skin tone and undertone (never lightened, darkened or tanned), same hair colour, length, texture and style, same age and body proportions — in both frames and in every panel of this run. If identity and styling conflict, identity wins.`,
    "BACKGROUND: seamless pure white studio (#FFFFFF), high-key even light, only a very faint neutral contact shadow on the floor — no tint, cast, gradient, vignette, texture, wrinkle or horizon; the same white and the same light in every panel.",
    itemTypeFocusLine(lockedItemType),
  ].join("\n");
}

/** The back rule for this panel, from the verified state — one line, or none. */
function buildBackStateLine(backState: BackState, panelQa: PanelQaInput): string[] {
  const frames = backFacingFramesLabel(panelQa);
  if (!frames) return [];
  if (backState === "present") {
    return [
      `- BACK DESIGN (verified on the product): the back carries the design listed above. ${frames} shows it in full — same artwork, size, position, colours and print effect. A clean back, a shrunken version, or one moved up to the neck is WRONG. Every other pose keeps its own facing and shows only the front.`,
    ];
  }
  if (backState === "absent") {
    return [
      `- BACK IS PLAIN (verified): the back carries no print, text, graphic, logo or patch. ${frames} shows a plain back in the item's own colour, fabric and construction — add nothing.`,
    ];
  }
  if (backState === "photo") {
    return [
      `- BACK FROM PHOTO: the BACK reference image(s) show this item's back. ${frames} reproduces exactly what they show — every print, text, graphic, logo, patch, seam and pocket at the same size and position, and nothing they do not show.`,
    ];
  }
  return [
    `- BACK NOT PHOTOGRAPHED: no reference shows this item's back. ${frames} must add nothing — no print, graphic, text or logo — and keep the back plain in the item's own colour and construction.`,
  ];
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

/** Studio item-reference sections: General (any view — accessories, flats),
 *  Front (front of the garment), Back (back of the garment). */
type ItemRefView = "general" | "front" | "back";
type ItemRefViewLists = { general: string[]; front: string[]; back: string[] };

function parseItemRefViews(views: unknown, fallbackRefs: unknown): ItemRefViewLists {
  const strList = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  if (views && typeof views === "object") {
    const o = views as Record<string, unknown>;
    const lists = { general: strList(o.general), front: strList(o.front), back: strList(o.back) };
    if (lists.general.length || lists.front.length || lists.back.length) return lists;
  }
  return { general: strList(fallbackRefs), front: [], back: [] };
}

/** Which attached images are the FRONT and which are the BACK — so the
 *  generator can never copy a back print onto the front (or vice versa).
 *  Only emitted when the operator actually sorted photos into Front/Back. */
function buildItemViewMapLines(args: { modelCount: number; itemViews: ItemRefView[] }): string[] {
  const front = args.itemViews.filter((v) => v === "front").length;
  const back = args.itemViews.filter((v) => v === "back").length;
  if (!front && !back) return [];
  const general = args.itemViews.filter((v) => v === "general").length;
  const range = (start: number, count: number) => (count === 1 ? `image ${start}` : `images ${start}–${start + count - 1}`);
  let cursor = args.modelCount + 1;
  const parts: string[] = [];
  if (general) {
    parts.push(`${range(cursor, general)} = GENERAL item photo(s) (any view: accessories, flats, details)`);
    cursor += general;
  }
  if (front) {
    parts.push(`${range(cursor, front)} = the FRONT of the item`);
    cursor += front;
  }
  if (back) {
    parts.push(`${range(cursor, back)} = the BACK of the item`);
    cursor += back;
  }
  return [
    "ITEM REFERENCE VIEW MAP (SERVER — the operator sorted the item photos by view; this is authoritative):",
    `- Attached reference images, in order: ${range(1, args.modelCount)} = MODEL identity refs; ${parts.join("; ")}.`,
    "- Everything visible on a FRONT photo exists ONLY on the front of the garment; everything visible on a BACK photo exists ONLY on the back. Never copy a back print / text / graphic onto the front, and never copy a front print / text / graphic onto the back.",
    "- Front-facing frames show only the FRONT content; back-facing frames show only the BACK content; side / three-quarter views show each side's own content in perspective.",
    ...(front && !back
      ? ["- No BACK photo was supplied: render the back exactly as the general photos / verified spec show it; if they show nothing, keep the back clean in the item colour — never invent a back design."]
      : []),
    ...(back && !front
      ? ["- No FRONT photo was supplied: render the front exactly as the general photos / verified spec show it; if they show nothing, keep the front clean in the item colour — never invent a front design."]
      : []),
  ];
}

/** QA judge input: item refs grouped and labelled by view. */
function buildLabelledItemRefContent(itemRefs: string[], views?: ItemRefView[]): any[] {
  const tagged = itemRefs.map((url, i) => ({ url, view: views?.[i] ?? "general" }));
  const groups: { view: ItemRefView; label: string }[] = [
    { view: "general", label: "ITEM reference images — GENERAL (any view: accessories, flats, details):" },
    { view: "front", label: "ITEM reference images — FRONT of the garment (everything here is on the front only):" },
    { view: "back", label: "ITEM reference images — BACK of the garment (everything here is on the back only):" },
  ];
  const hasSorted = tagged.some((t) => t.view !== "general");
  if (!hasSorted) {
    return [
      { type: "input_text", text: "ITEM reference images (outfit lock):" },
      ...tagged.map((t) => ({ type: "input_image", image_url: t.url })),
    ];
  }
  const out: any[] = [];
  for (const g of groups) {
    const urls = tagged.filter((t) => t.view === g.view).map((t) => t.url);
    if (!urls.length) continue;
    out.push({ type: "input_text", text: g.label });
    out.push(...urls.map((url) => ({ type: "input_image", image_url: url })));
  }
  return out;
}

type QaFrame = "left" | "right" | "both";
type QaReason = { frame: QaFrame; text: string };
const QA_MIN_CONFIDENCE = 0.75;
const normalizeForCompare = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * A "reason" that is actually a confirmation ("text matches the reference",
 * "logo present and correctly placed"). The judge lists these under reasons
 * when asked for structured output, and each one used to be shown to the
 * operator as a red failure. A line that also names a defect is not one.
 */
function looksLikeConfirmation(detail: string, observed: string): boolean {
  const t = `${detail} ${observed}`.toLowerCase();
  if (!t.trim()) return false;
  // Open-ended stems (differ|ent|s, invent|ed, relocat|ed …) and the contrast
  // words that introduce a defect after a compliment ("logo is correct, BUT…").
  // A first version anchored whole words and dropped 11 of 12 real defects.
  const defect =
    /\b(?:missing|absent|not (?:present|visible|shown|rendered|match\w*)|wrong|differ\w*|mismatch\w*|misspel\w*|garbled|merged|invent\w*|extra|added|moved|relocat\w*|resiz\w*|shrunk|shrink\w*|swap\w*|chang\w*|alter\w*|redesign\w*|simplif\w*|recolou?r\w*|duplicat\w*|omit\w*|lack\w*|remov\w*|barefoot|full standing|older|younger|incorrect\w*|instead of|should be|does not|doesn't|isn't|is not|are not|aren't|however|although|except|whereas|but\b)|;/;
  if (defect.test(t)) return false;
  return /\b(?:matches|match(?:ing|ed)?|correct(?:ly)?|consistent|as expected|identical|same as|accurate|present and|confirmed|no (?:issue|mismatch|difference|problem)|looks (?:right|good|fine)|preserved|intact|faithful)\b/.test(
    t
  );
}

/**
 * Structured judge verdicts → operator-facing reasons. The judge has produced
 * "misspelled as '<the expected string>'" and "full standing body" on an
 * upper-body crop, so each reason carries expected/observed/confidence and:
 * - expected == observed (after normalisation) is a self-contradiction → dropped;
 * - a confirmation phrased as a reason → dropped;
 * - confidence missing or < QA_MIN_CONFIDENCE → demoted to a note (a reason
 *   with no confidence is the judge not committing, not the judge being sure);
 * - the frame lets the Studio flag only the crop that is actually wrong.
 * Legacy string reasons are kept as-is on both frames.
 */
function parseQaReasons(value: unknown): { kept: QaReason[]; demoted: string[]; dropped: number } {
  const kept: QaReason[] = [];
  const demoted: string[] = [];
  let dropped = 0;
  if (!Array.isArray(value)) return { kept, demoted, dropped };
  for (const v of value.slice(0, 12)) {
    if (typeof v === "string") {
      const t = v.trim();
      if (!t) continue;
      if (looksLikeConfirmation(t, "")) {
        // Never silently discard what the judge attached to a verdict: a
        // "confirmation" still reaches the operator, as a note.
        demoted.push(`${t} (reads as a confirmation)`);
        dropped += 1;
        continue;
      }
      kept.push({ frame: "both", text: t });
      continue;
    }
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const cls = String(r.class || "").toUpperCase().trim();
    const frameRaw = String(r.frame || "").toLowerCase().trim();
    const frame: QaFrame = frameRaw.startsWith("l") ? "left" : frameRaw.startsWith("r") ? "right" : "both";
    const expected = typeof r.expected === "string" ? r.expected.trim() : "";
    const observed = typeof r.observed === "string" ? r.observed.trim() : "";
    const detail = typeof r.detail === "string" ? r.detail.trim() : "";
    const confidence = Number(r.confidence);
    const body = detail || (expected || observed ? `expected "${expected}", saw "${observed}"` : "");
    const text = [cls ? `${cls}:` : "", body].filter(Boolean).join(" ").trim().slice(0, 240);
    if (!text) continue;
    if (expected && observed && normalizeForCompare(expected) === normalizeForCompare(observed)) {
      dropped += 1;
      continue;
    }
    if (looksLikeConfirmation(detail, observed)) {
      demoted.push(`${text} (reads as a confirmation)`);
      dropped += 1;
      continue;
    }
    if (!Number.isFinite(confidence) || confidence < QA_MIN_CONFIDENCE) {
      demoted.push(`${text} (${Number.isFinite(confidence) ? "low" : "no"} confidence)`);
      continue;
    }
    kept.push({ frame, text });
  }
  return { kept: kept.slice(0, 8), demoted: demoted.slice(0, 6), dropped };
}

async function runPanelComplianceCheck(args: {
  openai: OpenAI;
  imageBase64: string;
  modelRefs: string[];
  itemRefs: string[];
  panelQa: PanelQaInput;
  /** View tag per itemRefs entry (general / front / back), same order. */
  itemRefViews?: ItemRefView[];
  /** Verified item spec (pre-generation analysis) so the judge can check text
   *  letter by letter and graphic placement side by side. */
  itemSpec?: string;
  backState: BackState;
  timeoutMs: number;
}) {
  // gpt-4o (not -mini): the verdict is now shown to the operator per crop, so
  // it has to be worth reading — mini's face/background judgements were noisy.
  const qaModel = (process.env.OPENAI_IMAGE_QA_MODEL || "gpt-4o").trim() || "gpt-4o";
  const qaGender = String(args.panelQa.modelGender || "").trim().toLowerCase();
  const legsCropPose = qaGender === "female" ? 7 : 5;
  const legsCropActive =
    Number(args.panelQa.poseA) === legsCropPose || Number(args.panelQa.poseB) === legsCropPose;
  const qaCategory = inferItemTypeCategory(args.panelQa.itemType);
  const upperBodyItem = qaCategory === "top" || qaCategory === "outerwear";
  const itemSpecForQa = String(args.itemSpec || "").trim();
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
              "- Back-view lock active for this panel: the back-facing frame must show exactly the back the item refs / spec establish.",
              args.backState === "present"
                ? "- The spec lists a design on the BACK. The back-facing frame must show it in full; a clean back, or a shrunken / relocated version, is a FAIL."
                : args.backState === "absent"
                  ? "- The back is verified PLAIN. Any print, text, graphic, logo or patch on the back-facing frame is a FAIL."
                  : args.backState === "photo"
                    ? "- The BACK reference image(s) show the back. Compare the back-facing frame with them: anything they show that is missing, changed or moved, or anything added that they do not show, is a FAIL."
                    : "- The back was not photographed. Any print, text, graphic, logo or patch on the back-facing frame is a FAIL.",
            ]
          : []),
        ...(legsCropActive
          ? [
              upperBodyItem
                ? `- Crop lock: Pose ${legsCropPose} is an UPPER-BODY product crop of the top (neckline to hem, head out of frame). A legs/shorts crop or a full standing body in that frame is a FAIL.`
                : `- Crop lock: Pose ${legsCropPose} is a LEGS-ONLY crop (waist to feet) of the model wearing the garment. Waistband-to-shoes with no head is CORRECT — do not fail it. Only a frame that also shows the head is a full standing body and a FAIL; so is an empty garment with nobody in it.`,
            ]
          : []),
        "- Identity: the person must be the same individual as the MODEL refs.",
        "- Cosmetics (background tint, centring, lighting) are observations only — never failures.",
      ].join("\n"),
    },
    ...(itemSpecForQa
      ? [
          {
            type: "input_text",
            text:
              "VERIFIED ITEM SPEC (what the item references contain — check every TEXT line letter by letter, and every LOGO / GRAPHIC placement and side, against the generated panel):\n" +
              itemSpecForQa,
          },
        ]
      : []),
    { type: "input_text", text: "MODEL reference images (identity lock):" },
    ...args.modelRefs.slice(0, 6).map((url) => ({ type: "input_image", image_url: url })),
    ...buildLabelledItemRefContent(args.itemRefs, args.itemRefViews),
    { type: "input_text", text: "Generated panel to audit:" },
    { type: "input_image", image_url: `data:image/png;base64,${args.imageBase64}` },
    {
      type: "input_text",
      text: [
        "Return JSON only with these keys:",
        "{",
        '  "pass": boolean,',
        '  "reasons": [ { "frame": "left" | "right" | "both", "class": "PRODUCT" | "POSE" | "IDENTITY" | "COVERAGE", "expected": string, "observed": string, "detail": string, "confidence": number 0-1 } ],',
        '  "notes": string[]',
        "}",
        "Set pass=false ONLY for the four failure classes below. List ONLY defects under \"reasons\" — never confirmations (\"text matches\", \"logo correct\"); those go in \"notes\" or nowhere. Each reason names the frame it applies to, what was expected (from the refs / spec / pose lock), what you actually observe, and your confidence (anything under 0.75, or a missing confidence, is treated as a note, not a failure).",
        "SCALE RULE: in a FULL-BODY frame small text (taglines, chest / back small lines) is only a few pixels tall — do NOT judge its spelling, legibility, or print effect there, and do not fail for it being faint; judge small text only in torso-crop and close-up frames. Large graphics, logos and prints are judged in EVERY frame by comparing them with the item reference photos: same artwork, same size relative to the garment, same position, same colours. A redesigned, simplified, resized, relocated or recoloured graphic is a PRODUCT failure even in a full-body frame.",
        "MISSPELLING RULE: before reporting a misspelling, transcribe the letters you actually see into \"observed\". If they equal \"expected\", it is NOT a failure — omit it.",
        "VISIBILITY RULE: fail only for something that would be visible from that frame's angle and crop. Inside labels, interior prints, care labels, inner waistbands and anything under another garment are never visible on a worn item — never fail for them. A back-waistband mark, back pocket or back print can be judged only in a back-facing frame; a front chest print only in a front-facing frame. A close-up frame does not establish which side of the garment it shows — never fail a close-up for a mark being on the \"wrong side\".",
        "CROP RULE: an upper-body crop shows the garment from neckline to hem with the head cut off; a torso crop shows mid-thigh to head; a legs crop shows waist to feet with NO head in frame. \"Full standing body\" means the head AND both feet are visible in the SAME frame — report it only when you can actually see both. A waist-to-feet frame showing the waistband and the shoes but no head IS the legs crop doing exactly what it was asked to do: never report that as a full standing body.",
        "HARDWARE RULE: chains, zips, buttons, rivets, belt loops, drawcords, eyelets and other hardware listed in the spec are part of the garment. They may hang, swing or be visible from any angle, including from behind, and they are never an invented graphic and never a \"back design\" violation — the back rules concern prints, text, graphics, logos and patches only. A placement the spec calls inner, inside, hidden or concealed must not be visible on the OUTSIDE of the garment; that one is a real failure.",
        "1. PRODUCT: any text is misspelled, garbled, merged, missing, duplicated, or on the wrong side/placement versus the item refs / spec; a logo or graphic is missing, invented, moved, resized, or its print effect changed; the garment colour, fit/silhouette, or construction clearly differs from the refs; a back-facing frame lacks the back design the refs / spec show, or shows a back design the refs do not.",
        "2. POSE / CROP: a frame shows a full standing body where a crop pose is expected; a crop of the wrong body region (e.g. legs/shorts where the top is expected); a close-up of the wrong item category; label/logo/patch details missing or relocated in the close-up; or the left/right poses swapped.",
        "3. IDENTITY: the person is clearly a DIFFERENT individual from the MODEL refs (different face structure, ethnicity, hair colour/length, or apparent age). Minor angle, expression, or lighting differences are NOT a failure.",
        swimwearActive
          ? "4. COVERAGE: nudity or partial nudity, or exposure beyond a regular bikini / one-piece (women) or swim trunks (men). Uncovered feet are allowed for swimwear."
          : "4. COVERAGE: nudity or partial nudity; a non-swimwear item shown without a proper top or with a bare torso; or a full-body frame where the model is plainly barefoot. FOOTWEAR EVIDENCE: before reporting barefoot, write what you actually see on the feet into \"observed\". Feet cropped out of frame, in shadow, or in dark shoes against a dark hem are NOT barefoot — if you cannot see them clearly, leave it out.",
        "NEVER fail for background tint, gradient, shadow, vignette, slight off-centre framing, lighting or colour temperature, expression, or hand position. Put such observations in \"notes\" (short, optional) — not in \"reasons\".",
        "If uncertain about a failure, set pass=true and put the doubt in notes.",
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
          // 420 truncated the JSON on any verdict with more than two reasons;
          // the unparsable remainder then became a fail-open pass.
          max_output_tokens: 1400,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text:
                    "You are a product-accuracy QA reviewer for fashion ecommerce panel outputs. " +
                    "You fail an output ONLY for a product mismatch against the item references / spec, a pose or crop violation, a clearly different person than the model references, or a coverage problem. " +
                    "Cosmetic issues (background tint, centring, lighting, expression) are notes, never failures. No prose. Return JSON only.",
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
  const { kept, demoted, dropped } = parseQaReasons(parsed.reasons);
  // A judge "fail" whose every reason was filtered out (self-contradiction /
  // confirmation / low confidence) is a pass; a judge "pass" that still lists
  // reasons keeps them as notes only.
  const failing = passFlag === false ? kept : [];
  const notes = [
    ...normalizeReasons(parsed.notes),
    ...demoted,
    ...(passFlag === true ? kept.map((r) => r.text) : []),
  ].slice(0, 8);
  const pass = failing.length === 0;
  return {
    decisive: true,
    pass,
    unavailable: false,
    judgeSaidPass: passFlag,
    droppedReasons: dropped,
    reasons: pass ? [] : failing.map((r) => r.text),
    reasonsBySide: {
      left: failing.filter((r) => r.frame !== "right").map((r) => r.text),
      right: failing.filter((r) => r.frame !== "left").map((r) => r.text),
    },
    notes,
    raw,
  };
}

/**
 * Heartbeat wrapper. A panel generation holds an otherwise-idle HTTP
 * connection for 60–90 s while OpenAI renders; mobile carriers / iOS Safari
 * drop idle connections in that window ("Load failed"), even though the
 * server finishes and logs success. When the client opts in with
 * `x-generate-stream: 1`, we answer 200 immediately and stream one space
 * every 10 s until the real JSON body is ready, then append it. Leading
 * whitespace is valid JSON, so `resp.json()` on the client is unchanged.
 * Non-2xx results are forwarded as their JSON body (status collapses to
 * 200); the client already treats a body without `imageBase64` — or with
 * `error` / `degraded` — as a failed panel. Without the header, behaviour is
 * exactly as before.
 */
export async function POST(req: NextRequest) {
  /**
   * `x-generate-job: <id>` (optional): run the generation DETACHED from this
   * response and park the finished body under that id. The heartbeat above
   * keeps a *live* connection from going idle, but it cannot help when the
   * page is frozen or discarded — switching apps, locking the phone, changing
   * browser tab, Android freezing the WebView. Without this the finished (and
   * paid-for) render dies with the socket; with it the client reconnects and
   * claims the result from `GET /api/generate/job?id=…`.
   * No header → behaviour is exactly as before.
   */
  const jobId = req.headers.get("x-generate-job")?.trim() ?? "";
  const bodyPromise = isValidJobId(jobId)
    ? runGenerateJob(jobId, async () => (await handleGenerate(req)).text())
    : null;

  if (req.headers.get("x-generate-stream") !== "1") {
    if (!bodyPromise) return handleGenerate(req);
    // Status collapses to 200 like the streaming path; the client already reads
    // the body (no `imageBase64`, or `error`/`degraded`) to decide success.
    return new Response(await bodyPromise, {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch {
          /* stream already closed */
        }
      }, 10_000);
      try {
        const text = bodyPromise ? await bodyPromise : await (await handleGenerate(req)).text();
        clearInterval(heartbeat);
        controller.enqueue(encoder.encode(text));
      } catch (err) {
        clearInterval(heartbeat);
        controller.enqueue(
          encoder.encode(JSON.stringify({ error: err instanceof Error ? err.message : "Generate failed" })),
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}

async function handleGenerate(req: NextRequest): Promise<Response> {
  // Wall clock for the generation log — OpenAI render time dominates it.
  const startedAt = Date.now();
  // Set once the request is parsed, so the outer catch can log what was asked for.
  let logCtx: (() => Omit<StudioGenerationLog, "outcome">) | null = null;
  try {
    // WMS auth: authenticated admin session (replaces carbon-gen cookie auth).
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const authPool = getPool();
    if (!authPool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const denied = await requireSessionScopes(authPool, session, [SCOPES.ADMIN]);
    if (denied) return denied;

    const {
      prompt,
      size,
      modelRefs,
      itemRefs,
      itemRefViews,
      panelQa,
      variationStrength,
      variationSeed,
      itemSpec,
      matrixId,
      backIsPlain,
      specConfirmed,
    } = await req.json();
    // Item refs sorted by view (Studio: General / Front / Back sections). The
    // image order sent to OpenAI is general → front → back so the prompt can
    // say which attached images are the front and which are the back.
    const viewLists = parseItemRefViews(itemRefViews, itemRefs);
    // Pre-generation item analysis (client → /api/openai/item-spec, possibly
    // edited by the operator). Appended INSIDE the server lock block and capped
    // so it can never push the prompt over the model limit.
    const itemSpecRaw =
      typeof itemSpec === "string" && itemSpec.trim()
        ? cutToBytes(itemSpec.trim().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"), LOCK_TEXT_MAX_BYTES + 100)
        : "";
    /* The back of a garment has THREE states, not two, and collapsing them is
       how you get both failure modes at once: an invented back print, and a
       real one dropped.
         present — a reference shows a design on the back (the spec's BACK line
                   says so, or a TEXT / LOGO / GRAPHIC line is placed there).
         absent  — the back was seen and is plain: the spec's BACK line says
                   plain, the operator ticked "the back is plain" after
                   checking the real garment, or a photo was sorted into the
                   Back section and the spec found nothing on it.
         unknown — nothing shows the back. "No evidence" is NOT "no design".
       Until 2026-09-29 the "present" detector never fired (it anchored on an
       unnumbered line the spec never produces), so every run was told to
       keep the back clean — including runs whose references showed a back
       print. */
    const specBack = parseSpecBackState(itemSpecRaw);
    const backPhotographed = viewLists.back.length > 0;
    const backState: BackState =
      specBack === "design" || specListsBackDesign(itemSpecRaw)
        ? "present"
        : specBack === "plain" || backIsPlain === true
          ? "absent"
          : backPhotographed
            ? "photo" // attached, but the analysis never described it — the photo rules, not a guess
            : "unknown";
    /* The spec's own BACK line is replaced with the resolved state, so the
       prompt (and the judge) can never carry "not photographed" next to "the
       back carries the design listed above". */
    const itemSpecText = itemSpecRaw ? withCanonicalBackLine(itemSpecRaw, backState) : "";
    const normalizedPanelQa = normalizePanelQa(panelQa);
    const backLockActive =
      isBackFacingPose(normalizedPanelQa.modelGender, normalizedPanelQa.poseA) ||
      isBackFacingPose(normalizedPanelQa.modelGender, normalizedPanelQa.poseB);
    // Pose/expression variation: rotate by a per-generation seed so consecutive
    // shots never collapse to the same default pose/face. Falls back to a
    // time-derived seed when the client doesn't send one (older builders).
    const resolvedVariationSeed = Number.isFinite(Number(variationSeed))
      ? Math.floor(Number(variationSeed))
      : Math.floor(Date.now() / 1000);

    type ImageSize = "1024x1024" | "1536x1024" | "1024x1536";
    const allowedSizes = new Set<ImageSize>(["1024x1024", "1536x1024", "1024x1536"]);
    const finalSize =
      typeof size === "string" && allowedSizes.has(size as ImageSize)
        ? (size as ImageSize)
        : ("1536x1024" as ImageSize);
    const imageModel = (process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5").trim() || "gpt-image-1.5";
    // Render quality for gpt-image-* edits (low | medium | high | auto). Pinned
    // high; env-overridable without a redeploy.
    const imageQuality = (process.env.OPENAI_IMAGE_QUALITY || "high").trim() || "high";
    // Content-moderation strictness for gpt-image-* edits ("auto" | "low"). "low"
    // is less restrictive — legitimate fashion reference photos (skin/swimwear)
    // otherwise get false-positive "blocked by safety" refusals. Env-overridable.
    const imageModeration = (process.env.OPENAI_IMAGE_MODERATION || "low").trim() || "low";

    // Every exit from here on is written to studio_generations — failures and
    // blocks included, which is the only way "how often does it fail, and why"
    // stops being a guess. (Before, only successes were logged.)
    const logBase = (): Omit<StudioGenerationLog, "outcome"> => ({
      tenantId: session?.tid,
      locationId: session?.lid,
      matrixId: typeof matrixId === "string" ? matrixId : null,
      itemType: normalizedPanelQa.itemType,
      modelName: normalizedPanelQa.modelName,
      modelGender: normalizedPanelQa.modelGender,
      panelNumber: normalizedPanelQa.panelNumber,
      poseA: normalizedPanelQa.poseA,
      poseB: normalizedPanelQa.poseB,
      imageModel,
      imageQuality,
      imageSize: finalSize,
      backState,
      backUnknown: backState === "unknown",
      specConfirmed: specConfirmed === true,
      specBytes: promptLen(itemSpecText),
      durationMs: Date.now() - startedAt,
    });
    logCtx = logBase;
    const logged = <T,>(entry: Partial<StudioGenerationLog> & { outcome: StudioGenerationLog["outcome"] }, response: T): T => {
      recordStudioGeneration({ ...logBase(), ...entry });
      return response;
    };

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const modelRefValues = Array.isArray(modelRefs) ? modelRefs : [];
    const itemRefValues = [...viewLists.general, ...viewLists.front, ...viewLists.back];
    const itemRefViewTags: ItemRefView[] = [
      ...viewLists.general.map((): ItemRefView => "general"),
      ...viewLists.front.map((): ItemRefView => "front"),
      ...viewLists.back.map((): ItemRefView => "back"),
    ];
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
    /* A back-facing frame of a back nobody has seen is a guess the operator
       pays for and then has to check against the real garment. Refuse it
       before any reference is downloaded: add a Back photo, or tick "the back
       is plain" after looking at the garment. */
    if (backLockActive && backState === "unknown") {
      const frames = backFacingFramesLabel(normalizedPanelQa);
      return logged(
        { outcome: "blocked", errorCode: "back_unverified" },
        NextResponse.json(
          {
            error: {
              type: "back_unverified",
              code: "back_unverified",
              message: `${frames} shows the BACK of the item, but no reference photo shows the back. Add a photo to the Back section, or tick "The back is plain" after checking the real garment, then generate again.`,
            },
          },
          { status: 400 }
        )
      );
    }

    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
      return logged(
        { outcome: "failed", errorCode: "no_api_key" },
        fallbackGenerateResponse("OPENAI_API_KEY is not set. Returned local fallback image.")
      );
    }

    const openai = new OpenAI({ apiKey });
    const imageTimeoutMs = getImageTimeoutMs();
    const poseVariationDirective = buildPoseVariationDirective({
      modelGender: normalizedPanelQa.modelGender,
      poseA: normalizedPanelQa.poseA,
      poseB: normalizedPanelQa.poseB,
      strength: normalizeStrength(variationStrength),
      seed: resolvedVariationSeed,
      itemType: normalizedPanelQa.itemType,
    });
    // NOTE: the server lock block is assembled AFTER the reference downloads
    // below, because its ITEM VIEW MAP and the identity line must describe the
    // images that actually reached OpenAI (a failed download shifts every
    // index after it).
    const buildServerLockBlock = (modelCount: number, itemViewMapLines: string[]) => [
      buildServerLockPrompt(normalizedPanelQa, modelCount),
      ...itemViewMapLines,
      ...(itemSpecText
        ? [
            "VERIFIED ITEM SPEC (observed on the actual item photos — every line MUST appear exactly as stated, in every frame and every panel; it overrides any generic styling):",
            itemSpecText,
            "- Every TEXT line is rendered letter-perfect (words, spelling, case, letterforms, colour, size) at its listed placement and side only — never a back print on the front or vice versa, never merged or swapped words, never extra text. Print effects (blurred / ghosted / faded / gradient / halftone / cracked) are part of the design and are rendered as such, never as a crisp clean version. The FIT/SILHOUETTE line is absolute: oversized reads clearly oversized, slim stays slim. HARDWARE / STITCHING / POCKET / MATERIAL lines match in kind, count, colour, finish and position — and a placement the spec calls INNER, INSIDE, HIDDEN or CONCEALED stays out of sight on BOTH sides of the body, never surfacing on the outside of the garment in any frame. Anything NOT CLEARLY VISIBLE stays plain — never invented.",
            "- Small chest / sleeve / neck text keeps its true garment size but is still spelled letter-perfect in crisp, clean letterforms, even in full-body frames — never pseudo-letters, scribbles or a smudge.",
            ...buildBackStateLine(backState, normalizedPanelQa),
          ]
        : buildBackStateLine(backState, normalizedPanelQa)),
      buildBrandSafetyLock(normalizedPanelQa.itemType),
      ...(poseVariationDirective ? [poseVariationDirective] : []),
    ].join("\n");

    // Keep model identity anchors bounded; include all item refs provided by section 0.5.
    const modelAnchors = normalizedModelRefs.slice(0, 6);
    const itemAnchors = normalizedItemRefs;
    // View tag per item anchor; if normalisation changed the count (it only
    // drops on error, which 400s above) fall back to "general" for all.
    const itemAnchorViews: ItemRefView[] =
      itemRefViewTags.length === itemAnchors.length ? itemRefViewTags : itemAnchors.map((): ItemRefView => "general");

    const allRefs = [...modelAnchors, ...itemAnchors];
    const downloaded = await Promise.allSettled(
      allRefs.map((url, idx) => downloadReferenceAsFile(url, idx))
    );

    const referenceFiles = downloaded
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof downloadReferenceAsFile>>> => r.status === "fulfilled")
      .map((r) => r.value.file);
    // Data URLs for the QA vision pass (same bytes the edit call uses).
    const modelRefDataUrls = downloaded
      .slice(0, modelAnchors.length)
      .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof downloadReferenceAsFile>>> => r.status === "fulfilled")
      .map((r) => r.value.dataUrl);
    const itemRefDownloads = downloaded
      .slice(modelAnchors.length)
      .map((r, i) => ({ r, view: itemAnchorViews[i] ?? "general" }))
      .filter(
        (e): e is { r: PromiseFulfilledResult<Awaited<ReturnType<typeof downloadReferenceAsFile>>>; view: ItemRefView } =>
          e.r.status === "fulfilled"
      );
    const itemRefDataUrls = itemRefDownloads.map((e) => e.r.value.dataUrl);
    const itemRefViewsForQa = itemRefDownloads.map((e) => e.view);
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
      return logged(
        { outcome: "failed", errorCode: "ref_download", errorMessage: summary.details, modelRefCount: modelFilesCount, itemRefCount: itemFilesCount },
        NextResponse.json(
          {
            error: "Unable to download required reference images.",
            details: summary.details,
            failedIndexes: summary.failedIndexes,
          },
          { status: 400 }
        )
      );
    }

    const serverLockBlock = buildServerLockBlock(
      modelFilesCount,
      buildItemViewMapLines({ modelCount: modelFilesCount, itemViews: itemRefViewsForQa })
    );
    const clamped = clampLockedPrompt(prompt, serverLockBlock);
    const lockedPrompt = clamped.prompt;
    /* Trimming throws away the MIDDLE of the instructions and generates anyway.
       It has already cost real output once (2026-08-26: panels ignored the item
       spec because the spec sat in the trimmed region), and the only trace was
       a server log nobody reads. It still trims rather than failing — refusing
       would block a product the operator needs photos for — but the overflow
       now travels back with the image so the Studio can show it, instead of
       silently producing a worse render. */
    const promptOverflowBytes = clamped.trimmed
      ? Math.max(0, promptLen(prompt) + promptLen(serverLockBlock) + 2 - MODEL_PROMPT_MAX_CHARS)
      : 0;
    if (clamped.trimmed) {
      console.warn(
        `[generate] PROMPT TRIMMED — over the ${MODEL_PROMPT_MAX_CHARS}-byte limit by ~${promptOverflowBytes} bytes; ` +
          `the middle of the client prompt was dropped. Server locks and the item spec were preserved. ` +
          `Panel ${normalizedPanelQa.panelNumber ?? "?"}, item type "${normalizedPanelQa.itemType ?? "?"}".`
      );
    }
    if (modelFilesCount < 3) {
      return logged(
        { outcome: "failed", errorCode: "ref_download_model", modelRefCount: modelFilesCount, itemRefCount: itemFilesCount },
        NextResponse.json(
          {
            error:
              "Locked model is under-specified after download. At least 3 model references must be successfully readable.",
          },
          { status: 400 }
        )
      );
    }

    let b64: string | null = null;
    const logRefs = { modelRefCount: modelFilesCount, itemRefCount: itemFilesCount, promptBytes: promptLen(lockedPrompt), promptTrimmed: clamped.trimmed };
    try {
      // Only the configured model — never silently substitute a different
      // (paid) model. No input_fidelity: on gpt-image edits it forces faithful
      // reproduction of the faces in ALL input images — including any person
      // wearing the garment in the ITEM references — and gpt-image-2 rejects
      // the parameter outright. Identity is held by the prompt's model-ref line.
      const edited = await withTimeout(
        openai.images.edit({
          model: imageModel,
          image: referenceFiles,
          prompt: enforcePromptLength(lockedPrompt),
          size: finalSize,
          quality: imageQuality as any,
          moderation: imageModeration as any,
        } as any),
        imageTimeoutMs,
        "OpenAI image generation"
      );
      b64 = edited.data?.[0]?.b64_json ?? null;
    } catch (err: any) {
      const code = String(err?.code || "");
      const type = String(err?.type || "");
      const message = String(err?.message || "");
      if (isOpenAiAuthError(err)) {
        return logged(
          { ...logRefs, outcome: "failed", errorCode: "openai_auth", errorMessage: message },
          NextResponse.json(
            {
              error:
                "OpenAI authentication failed on server. Update OPENAI_API_KEY in production env and redeploy.",
            },
            { status: 500 }
          )
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
        return logged(
          { ...logRefs, outcome: "blocked", errorCode: code || "moderation_blocked", errorMessage: message },
          NextResponse.json(
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
          )
        );
      }
      return logged(
        { ...logRefs, outcome: "failed", errorCode: code || type || "unknown", errorMessage: message },
        NextResponse.json(
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
        )
      );
    }

    if (!b64) {
      return logged(
        { ...logRefs, outcome: "failed", errorCode: "no_image" },
        NextResponse.json(
          {
            error: {
              type: "generation_failed",
              code: "no_image",
              message: "The provider returned no image. Nothing usable was generated.",
            },
          },
          { status: 502 }
        )
      );
    }

    const strictLocksEnabled =
      (process.env.STRICT_PANEL_LOCKS || "true").trim().toLowerCase() !== "false";
    // When QA can't reach a confident verdict (inconclusive, or the QA call itself
    // failed/timed out), fail open by default: serve the already-generated image
    // instead of discarding it. Set PANEL_QA_FAIL_OPEN=false to hard-block instead.
    const qaFailOpen =
      (process.env.PANEL_QA_FAIL_OPEN || "true").trim().toLowerCase() !== "false";
    let qaWarnings: string[] = [];
    let qaWarningsBySide: { left: string[]; right: string[] } | null = null;
    let qaNotes: string[] = [];
    let qa: any = null;

    /* The judge is a second vision call. Waiting for it before answering kept
       the operator staring at nothing for another 10-20 s per panel, for a
       verdict that only decorates an image they have already paid for. When the
       client supplies `x-panel-qa`, the image goes back now and the judge runs
       on; the Studio collects the flags from /api/generate/qa and applies them
       to the crops in place. Only valid in fail-open mode — blocking on an
       inconclusive verdict requires having it first. */
    const deferredQaId = req.headers.get("x-panel-qa")?.trim() ?? "";
    const imageB64: string = b64;
    if (strictLocksEnabled && qaFailOpen && isValidQaId(deferredQaId)) {
      const judge = () =>
        runPanelComplianceCheck({
          openai,
          imageBase64: imageB64,
          modelRefs: modelRefDataUrls.length ? modelRefDataUrls : modelAnchors,
          itemRefs: itemRefDataUrls.length ? itemRefDataUrls : itemAnchors,
          itemRefViews: itemRefDataUrls.length ? itemRefViewsForQa : itemAnchorViews,
          panelQa: normalizedPanelQa,
          itemSpec: itemSpecText,
          backState,
          timeoutMs: imageTimeoutMs,
        });
      /* The row is written now, with the verdict attached when it lands — the
         log exists to answer "what did the judge say", so it must not record
         "QA never ran" for every panel. */
      const logId = crypto.randomUUID();
      const inserted = recordStudioGeneration({ ...logBase(), ...logRefs, id: logId, outcome: "ok" });
      void runPanelQa(deferredQaId, async () => {
        let v: any;
        try {
          v = await judge();
        } catch (e: any) {
          v = { decisive: false, pass: true, unavailable: true, reasons: [`Compliance check threw: ${e?.message || "unknown error"}`] };
        }
        const warnings: string[] =
          v.decisive && !v.pass ? (Array.isArray(v.reasons) ? v.reasons.map(String).filter(Boolean) : []) : [];
        const side = v.reasonsBySide;
        const bySide =
          warnings.length && side && Array.isArray(side.left) && Array.isArray(side.right)
            ? { left: side.left.map(String), right: side.right.map(String) }
            : null;
        const notes: string[] = v.decisive ? (Array.isArray(v.notes) ? v.notes.map(String).filter(Boolean) : []) : [];
        if (warnings.length) console.warn(`[generate] Panel QA FAILED (deferred) — ${warnings.join(" | ")}`);
        await inserted.catch(() => {});
        updateStudioGenerationQa(logId, {
          qaDecisive: v.decisive === true,
          qaPass: v.decisive ? v.judgeSaidPass === true : null,
          qaWarnings: warnings.length,
          qaReasons: v.decisive ? warnings : Array.isArray(v.reasons) ? v.reasons.map(String) : [],
          qaNotes: notes,
          qaDropped: v.droppedReasons ?? 0,
        });
        return { qaWarnings: warnings, qaWarningsBySide: bySide, qaNotes: notes, unavailable: v.decisive !== true };
      });
      return NextResponse.json({
        imageBase64: imageB64,
        qaId: deferredQaId,
        qaPending: true,
        ...(clamped.trimmed ? { promptTrimmed: true, promptOverflowBytes } : {}),
        backState,
      });
    }

    if (strictLocksEnabled) {
      try {
        qa = await runPanelComplianceCheck({
          openai,
          imageBase64: b64,
          modelRefs: modelRefDataUrls.length ? modelRefDataUrls : modelAnchors,
          itemRefs: itemRefDataUrls.length ? itemRefDataUrls : itemAnchors,
          itemRefViews: itemRefDataUrls.length ? itemRefViewsForQa : itemAnchorViews,
          panelQa: normalizedPanelQa,
          itemSpec: itemSpecText,
          backState,
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
        // Confident lock violation. Owner decision 2026-08-26: NEVER discard a
        // paid render — serve it flagged with the exact reasons so the operator
        // sees the image AND the verdict and decides (the Studio delivers such
        // crops unselected with a red QA badge). Blocking here threw away all
        // four panels of a run with no explanation.
        qaWarnings = (Array.isArray(qa.reasons) ? qa.reasons : []).map((r: unknown) => String(r)).filter(Boolean);
        const side = qa.reasonsBySide;
        if (side && Array.isArray(side.left) && Array.isArray(side.right)) {
          qaWarningsBySide = { left: side.left.map(String), right: side.right.map(String) };
        }
        console.warn(`[generate] Panel QA FAILED — serving flagged: ${qaWarnings.join(" | ")}`);
      }
      if (qa.decisive) {
        // Cosmetic observations (background tint, centring, lighting) never fail
        // a render; they ride along as muted notes for the operator.
        qaNotes = (Array.isArray(qa.notes) ? qa.notes : []).map((r: unknown) => String(r)).filter(Boolean);
      }
      if (!qa.decisive && !qaFailOpen) {
        // Strict mode: block when QA could not confidently clear the image.
        const unavailable = qa.unavailable === true;
        return logged(
          {
            ...logRefs,
            outcome: "blocked",
            errorCode: unavailable ? "qa_unavailable_blocked" : "qa_inconclusive_blocked",
            qaDecisive: false,
            qaReasons: qa.reasons,
          },
          NextResponse.json(
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
          )
        );
      }
      if (!qa.decisive) {
        console.warn(
          `[generate] Panel QA non-decisive (${qa.unavailable ? "unavailable" : "inconclusive"}); serving image (fail-open).`,
          qa.reasons
        );
      }
    }
    return logged(
      {
        ...logRefs,
        outcome: "ok",
        qaDecisive: qa ? qa.decisive === true : null,
        // The judge's own verdict, before our filters: a "fail" whose reasons
        // were all confirmations is logged as pass=false/warnings=0 so the
        // filter's effect stays visible.
        qaPass: qa?.decisive ? qa.judgeSaidPass === true : null,
        qaWarnings: qaWarnings.length,
        qaReasons: qa?.decisive ? qaWarnings : Array.isArray(qa?.reasons) ? qa.reasons.map(String) : [],
        qaNotes,
        qaDropped: qa?.droppedReasons ?? 0,
      },
      NextResponse.json({
        imageBase64: b64,
        ...(qaWarnings.length ? { qaWarnings } : {}),
        ...(qaWarnings.length && qaWarningsBySide ? { qaWarningsBySide } : {}),
        ...(qaNotes.length ? { qaNotes } : {}),
        // Rides back with the image so a trimmed prompt is visible in the
        // Studio instead of only in a server log.
        ...(clamped.trimmed ? { promptTrimmed: true, promptOverflowBytes } : {}),
        backState,
      })
    );
  } catch (err: unknown) {
    console.error("Generate failed:", err);
    const reason = err instanceof Error ? err.message : "Generate failed";
    if (logCtx) {
      recordStudioGeneration({
        ...logCtx(),
        outcome: "failed",
        errorCode: isOpenAiAuthError(err) ? "openai_auth" : "exception",
        errorMessage: reason,
      });
    }
    if (isOpenAiAuthError(err)) {
      return NextResponse.json(
        {
          error:
            "OpenAI authentication failed on server. Update OPENAI_API_KEY in production env and redeploy.",
        },
        { status: 500 }
      );
    }
    return fallbackGenerateResponse(reason);
  }
}
