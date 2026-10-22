import { withActivity } from "@/lib/server/activity-log";
/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI, { toFile } from "openai";
import sharp from "sharp";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import {
  LOCK_TEXT_MAX_BYTES,
  parseSpecBackState,
  specListsBackDesign,
  withCanonicalBackLine,
  withInstructionFit,
} from "@/lib/studio-item-spec";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  recordStudioGeneration,
  type StudioGenerationLog,
} from "@/lib/server/studio-generation-log";
import {
  gateRunAnchor,
  isValidRunId,
  peekRunAnchor,
  readRunAnchorGate,
  settleRunAnchor,
  stashRunPanel,
  waitRunAnchor,
  type AnchorGateResult,
} from "@/lib/server/run-qa-store";
import { runAnchorGate } from "@/lib/server/run-qa";
import { isBackFacingPose } from "@/lib/server/studio-frames";
import {
  isValidLookModelId,
  lookAnchorPrefix,
  markLookAnchorGate,
  normalizeLookColour,
  storeLookAnchor,
} from "@/lib/server/studio-look-anchors";
import { ACCESSORY_KINDS, type AccessoryKind } from "@/lib/accessoryShots";
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
import { isLowerBodyProductCategory, PANEL_SIZE, toPanelLayout } from "@/lib/panelGeneration";
import { isValidJobId, runGenerateJob, takeEarlyCancel } from "@/lib/server/generate-jobs";

/* Panels come back at 3200x2000. Run QA and the panel-1 reference sent with
   panels 2-4 work from a 1536-wide copy (the size panels used to be): same
   judging, same input cost, a quarter of the memory held per run. */
async function workingCopy(b64: string): Promise<string> {
  try {
    const buf = Buffer.from(b64, "base64");
    const meta = await sharp(buf).metadata();
    if (!meta.width || meta.width <= 1536) return b64;
    return (await sharp(buf).resize({ width: 1536 }).png().toBuffer()).toString("base64");
  } catch {
    return b64;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/**
 * A network fault that says nothing about the request, so repeating it is
 * reasonable. "terminated" is undici's message when a response socket closes
 * mid-flight, and it arrives as a bare TypeError with the real cause nested.
 *
 * Our own timeout is deliberately NOT transient: the budget expired, and
 * spending it again helps nobody.
 */
const TRANSIENT_NETWORK_ERROR =
  /(terminated|econnreset|socket hang up|other side closed|epipe|etimedout|econnrefused|enotfound|eai_again|fetch failed|network error|premature close|connection error)/i;

function isTransientNetworkError(e: any): boolean {
  if (!e) return false;
  if (/timed out after \d+ms/i.test(String(e?.message ?? ""))) return false;
  const seen: string[] = [];
  let node: any = e;
  for (let depth = 0; node && depth < 4; depth += 1) {
    seen.push(String(node?.message ?? ""), String(node?.code ?? ""), String(node?.errno ?? ""));
    node = node.cause;
  }
  return seen.some((s) => s && TRANSIENT_NETWORK_ERROR.test(s));
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
  /** Set when the Studio is shooting an accessory (lib/accessoryShots.ts): the
   *  two frames are SHOTS, not poses, so every pose-keyed rule stands down. */
  accessoryKind: string;
};

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
    accessoryKind: ACCESSORY_KINDS.includes(String(value?.accessoryKind || "") as AccessoryKind)
      ? String(value.accessoryKind)
      : "",
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
  } else if (has("bracelet", "anklet", "necklace", "pendant", "choker", "earring", "rings?\\b", "bangle", "watch", "jewel")) {
    details =
      "every bead, link, charm, stone and setting with the same count, size and spacing, the metal tone and finish, the chain or band style, and the clasp and extender";
  } else if (has("sunglass", "eyewear", "glasses")) {
    details = "frame shape and thickness, lens colour and tint, bridge, hinges and temple arms, and any logo at its exact size and position";
  } else if (has("bag", "belt", "hat", "caps?\\b", "beanie", "bow ?tie", "accessor", "scarf", "sock")) {
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
  if (panelQa.accessoryKind) {
    return [
      `IDENTITY: in every shot that shows a person, it is ${modelName} (${modelGender}) — exactly the person in attached ${modelRange}, the MODEL references: same skin tone and undertone (never lightened, darkened or tanned), same hands, same build, and where the face or hair is in frame the same face and hair. Product-only shots contain no person and no hands at all.`,
      "BACKGROUND: seamless pure white studio (#FFFFFF), high-key even light, only a very faint neutral contact shadow — the same white in every shot. The one exception is an editorial flat-lay shot, which is shot straight down on a light neutral linen surface.",
      itemTypeFocusLine(lockedItemType),
    ].join("\n");
  }
  return [
    `IDENTITY: the person in every frame is ${modelName} (${modelGender}) — exactly the person in attached ${modelRange}, the MODEL references: same face geometry (eye shape and spacing, nose, lips, jawline, cheeks, brows), same skin tone and undertone (never lightened, darkened or tanned), same hair colour, length, texture and style, same age and body proportions — in both frames and in every panel of this run. If identity and styling conflict, identity wins.`,
    "BACKGROUND: seamless pure white studio (#FFFFFF), high-key even light, only a very faint neutral contact shadow on the floor — no tint, cast, gradient, vignette, texture, wrinkle or horizon; the same white and the same light in every panel.",
    itemTypeFocusLine(lockedItemType),
  ].join("\n");
}

/** The back rule for this panel, from the verified state — one line, or none. */
/**
 * What exactly is on the back, read off the spec, for the back-facing frames.
 *
 * "The back carries the design listed above" never said WHAT it was. On black
 * ripped shorts whose only back feature is a small leather waistband patch,
 * pose 7 read "the back design" as artwork and invented a print, and carried
 * the front rips round onto the back of the legs (the spec says that zone is
 * plain). Naming the elements — and that nothing else is there — closes it.
 */
/** Same test as lib/panelGeneration.ts specHasBackWaistbandLabel (kept local: that module draws on a canvas). */
function specHasBackWaistbandLabelLine(spec: string): boolean {
  return String(spec || "")
    .split("\n")
    .some((l) => /\bback\b/i.test(l) && /waistband|waist band|belt line/i.test(l) && /label|patch|text|logo|print|tag|embroider/i.test(l));
}

/** The operator's label photo, sent with the Pose 7 panel as a command (owner,
 *  2026-10-14: "add this label to OpenAI as a command" — no paste, no crop tool). */
function buildJeansLabelLine(imageNumber: number, side: string): string {
  return `- BACK-WAISTBAND LABEL (COMMAND — overrides every other line about how the back-waistband label looks): attached image ${imageNumber} is a photograph of THIS product's real label, the patch sewn on the back of the waistband. It is not a product photo for anything else and contains no person. In ${side} Pose 7, the zoomed-in back crop, put THIS label on the back of the waistband, at the position and size the item photos show it: copy it exactly as photographed — the same shape and proportions, colours and material, border and stitching, the same logo and every letter in the same font and spacing, level with the waistband. Do not redesign, simplify, re-letter, recolour or invent any part of it; if a letter is too small to read, keep the photo's letters as they are rather than writing new ones.`;
}

/** Owner's hard lock: the zoomed-in back never shows skin. The item photos are
 *  often the jeans on a bare back, and Pose 7 copied that gap (Julian Jeans). */
function buildPose7CoverLine(side: string, showsLabel: boolean): string {
  return `- POSE 7 HARD LOCK — NO SKIN: in ${side} Pose 7, the zoomed-in back crop, ${
    showsLabel
      ? "the back hem of the top is lifted only to the top edge of the waistband and rests on it, touching it all the way across — the back of the waistband and its label show in full below that edge, and"
      : "the top hangs over the waistband exactly as in every other frame, and"
  } NO bare skin of the lower back or the sides shows anywhere. Where an item photo shows the product on a bare back, that is only how it was photographed — in this shoot the top covers the back down to the waistband.`;
}

/** Owner's hard lock: the full-body back view never shows the label — the top
 *  is over it (male Pose 4; female Pose 2 when the product has a back label). */
function buildBackCoverLine(side: string, pose: number, itemType: string): string {
  return `- POSE ${pose} HARD LOCK — THE TOP COVERS THE BACK OF THE WAISTBAND: in ${side} Pose ${pose}, the full-body back view, the top hangs straight down over the waistband all the way round — never tucked, lifted, folded or bunched up. The back of the waistband, the back belt loops and any label or patch on them are completely hidden under it: no label, patch, tag, text or logo shows at the back of the waistband in Pose ${pose}. Below the hem, the back of the ${itemType || "product"} shows exactly as photographed. No skin shows.`;
}

/** The close-up picks "branding" first, and a bottom's only branding is often
 *  the back-waistband label — which would then be drawn, not pasted. */
function buildCloseUpFrontLine(side: string, pose: number, itemType: string, labelPose: number | null): string {
  return `- CLOSE-UP (${side} Pose ${pose}): a FRONT detail of the ${itemType || "product"} that the item photos show — its closure or hardware, a front pocket, the wash or the stitching — never the back-waistband label or patch${
    labelPose ? `, which only Pose ${labelPose} shows` : ", which no frame of this shoot shows"
  }.`;
}

const BACK_DISTRESS = /\b(?:rips?|ripped|tears?|torn|holes?|distress\w*|fray\w*|abrasions?|whisker\w*|faded|fading|destroyed)\b/i;

function backElementsFromSpec(spec: string): { elements: string[]; plainZones: string[]; distress: string[] } {
  const elements: string[] = [];
  const plainZones: string[] = [];
  /* Rips and distressing the spec itself places on the back — "DISTRESSING
     (back, …)" lines and distressed BACK zones. The back lines below must keep
     them, not wipe them with "no rips or distressing". */
  const distress: string[] = [];
  for (const raw of String(spec || "").split("\n")) {
    const line = raw.replace(/^\s*\d+\.\s*/, "").trim();
    if (!line) continue;
    const backZone = /^ZONE\s*—\s*(BACK[^:]*):\s*(.+)$/i.exec(line);
    if (backZone && !/^plain\b/i.test(backZone[2].trim()) && BACK_DISTRESS.test(backZone[2])) {
      distress.push(`${backZone[1].trim().toLowerCase()}: ${backZone[2].replace(/\.$/, "").trim()}`);
    }
    if (/^DISTRESSING\b/i.test(line) && /\bback\b/i.test(line) && !/^DISTRESSING\s*:\s*none\b/i.test(line)) {
      distress.push(line.replace(/^DISTRESSING\s*/i, "").replace(/^[:(\s]+|[)\s.]+$/g, "").trim());
      continue;
    }
    if (/^ZONE\s*—\s*BACK[^:]*:\s*plain\b/i.test(line)) {
      plainZones.push(line.replace(/^ZONE\s*—\s*/i, "").replace(/:\s*plain[^.]*\.?/i, "").trim().toLowerCase());
      continue;
    }
    if (!/^(TEXT|LOGO\/ICON|GRAPHIC|PRINT|LABEL\/PATCH)\b/i.test(line)) continue;
    if (!/\bback\b/i.test(line)) continue;
    const what = line
      .replace(/\s*Reproduce verbatim[\s\S]*$/i, "")
      .replace(/\s*[-—]\s*(?:same|exact)\b[\s\S]*$/i, "")
      .replace(/\.$/, "")
      .trim();
    if (what) elements.push(what);
  }
  return { elements: elements.slice(0, 4), plainZones, distress: distress.slice(0, 4) };
}

/** The back's own rips, named inside the back line (a carve-out lives in the line it carves out of). */
function backDistressClause(distress: string[]): string {
  return distress.length ? ` It keeps the rips and distressing the spec places on the back — ${distress.join(" | ")} — and nothing more.` : "";
}

/** `waistbandCarve`: what the back waistband shows in this panel's back frames
 *  (covered by the top in Pose 4, a label placeholder in Pose 7) — said inside
 *  the back line, which otherwise asks for every back element in every back frame. */
function buildBackStateLine(backState: BackState, panelQa: PanelQaInput, spec = "", waistbandCarve = ""): string[] {
  return buildBackStateLineBase(backState, panelQa, spec).map((l) => l + waistbandCarve);
}

function buildBackStateLineBase(backState: BackState, panelQa: PanelQaInput, spec = ""): string[] {
  const frames = backFacingFramesLabel(panelQa);
  if (!frames) return [];
  const { elements, plainZones, distress } = backElementsFromSpec(spec);
  const distressClause = backDistressClause(distress);
  if (backState === "present") {
    if (elements.length) {
      return [
        `- BACK (verified on the product): ${frames} shows exactly these on the back of the product, at their own size and position, and NOTHING ELSE: ${elements.join(" | ")}${
          distress.length ? ` | ${distress.join(" | ")}` : ""
        }. Every other part of the product's back is plain in its own colour and fabric — no added print, graphic, artwork or text, and no ${
          distress.length ? "other " : ""
        }rips or distressing${plainZones.length ? ` (plain: ${plainZones.join(", ")})` : ""}. A small patch or label stays small; it never becomes a large back print. Every other pose keeps its own facing and shows only the front.`,
      ];
    }
    return [
      `- BACK DESIGN (verified on the product): the back carries the design listed above. ${frames} shows it in full — same artwork, size, position, colours and print effect. A clean back, a shrunken version, or one moved up to the neck is WRONG.${distressClause} Every other pose keeps its own facing and shows only the front.`,
    ];
  }
  if (backState === "absent") {
    return [
      `- BACK IS PLAIN (verified): the back carries no print, text, graphic, logo or patch. ${frames} shows a plain back in the item's own colour, fabric and construction — add nothing.${distressClause}`,
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

/** Studio item-reference sections: General (any view — accessories, flats),
 *  Front (front of the garment), Back (back of the garment), and Style with —
 *  OTHER products (a shirt, shoes, a bracelet) the model wears WITH the item.
 *  Style-with photos are never the product: no spec, no QA, no fidelity lock. */
type ItemRefView = "general" | "front" | "back" | "styling";
type ItemRefViewLists = { general: string[]; front: string[]; back: string[]; styling: string[] };

/** OpenAI's edit endpoint takes 16 images; model refs (≤6) and the product come first. */
const MAX_STYLING_REFS = 6;

function parseItemRefViews(views: unknown, fallbackRefs: unknown): ItemRefViewLists {
  const strList = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0) : [];
  if (views && typeof views === "object") {
    const o = views as Record<string, unknown>;
    const lists = {
      general: strList(o.general),
      front: strList(o.front),
      back: strList(o.back),
      styling: strList(o.styling).slice(0, MAX_STYLING_REFS),
    };
    if (lists.general.length || lists.front.length || lists.back.length) return lists;
    return { general: strList(fallbackRefs), front: [], back: [], styling: lists.styling };
  }
  return { general: strList(fallbackRefs), front: [], back: [], styling: [] };
}

/**
 * OpenAI's edit endpoint documents "up to 16 images" for gpt-image-2. Nothing
 * enforced it: 12 panels in 14 days went out with 17-18, and whatever OpenAI
 * did with the tail (the Back photos, the Style-with pieces, the colour photo)
 * the prompt's image numbers still pointed at it. Enforced here, before any
 * download, with a priority: the anchor, the colourway photo, the Style-with
 * pieces and 3 model refs are kept; General photos go first (from the end),
 * then Front/Back beyond 3 each, then model refs beyond 3. What was left out
 * is logged and returned.
 */
const MAX_INPUT_IMAGES = Math.max(4, Math.min(16, Number(process.env.OPENAI_IMAGE_MAX_INPUTS) || 16));
const MIN_MODEL_REFS = 3;
const MAX_MODEL_REFS = 6;
const KEPT_PER_SIDE = 3;

type DroppedRefs = Partial<Record<"model" | "general" | "front" | "back" | "styling", number[]>>;

function capReferenceImages(args: {
  modelCount: number;
  lists: ItemRefViewLists;
  /** The colourway photo is the last General entry when set. */
  hasColorPhoto: boolean;
  anchorSlots: number;
}): { modelKeep: number; lists: ItemRefViewLists; dropped: DroppedRefs } {
  const lists: ItemRefViewLists = {
    general: [...args.lists.general],
    front: [...args.lists.front],
    back: [...args.lists.back],
    styling: [...args.lists.styling],
  };
  let modelKeep = Math.min(MAX_MODEL_REFS, args.modelCount);
  const dropped: DroppedRefs = {};
  const drop = (view: keyof DroppedRefs, position: number) => (dropped[view] ??= []).unshift(position);
  const total = () =>
    modelKeep + lists.general.length + lists.front.length + lists.back.length + lists.styling.length + args.anchorSlots;
  /* The colourway photo is a colour swatch, not a view of the garment: at
     least one real product photo always stays besides it. */
  const products = () =>
    lists.general.length - (args.hasColorPhoto ? 1 : 0) + lists.front.length + lists.back.length;
  /** The longer of Front/Back, if it is longer than `floor`. */
  const longerSide = (floor: number): "front" | "back" | null => {
    const side = lists.back.length >= lists.front.length ? "back" : "front";
    return lists[side].length > floor ? side : null;
  };

  while (total() > MAX_INPUT_IMAGES && products() > 1) {
    const plain = lists.general.length - (args.hasColorPhoto ? 1 : 0);
    if (plain <= 0) break;
    lists.general.splice(plain - 1, 1);
    drop("general", plain);
  }
  for (let side = longerSide(KEPT_PER_SIDE); total() > MAX_INPUT_IMAGES && side; side = longerSide(KEPT_PER_SIDE)) {
    drop(side, lists[side].length);
    lists[side].pop();
  }
  while (total() > MAX_INPUT_IMAGES && modelKeep > MIN_MODEL_REFS) {
    drop("model", modelKeep);
    modelKeep -= 1;
  }
  for (let side = longerSide(0); total() > MAX_INPUT_IMAGES && side && products() > 1; side = longerSide(0)) {
    drop(side, lists[side].length);
    lists[side].pop();
  }
  while (total() > MAX_INPUT_IMAGES && lists.styling.length) {
    drop("styling", lists.styling.length);
    lists.styling.pop();
  }
  return { modelKeep, lists, dropped };
}

/* ── Anchor: panel 1 sets the look (lib/server/run-qa-store.ts) ─────────── */

/** A follower waits this long for panel 1 at most. */
const ANCHOR_WAIT_MAX_MS = 240_000;
/** The Studio polls an anchored panel for ~8 min from its POST; stay inside that. */
const FOLLOWER_WINDOW_MS = 460_000;
/** A render takes ~80-95 s: never start one with less than this left. */
const MIN_RENDER_WINDOW_MS = 95_000;
/** The gate is one gpt-4o call (two attempts); past this it is "unavailable" and holds nothing. */
const ANCHOR_GATE_MAX_MS = 80_000;
const ANCHOR_GATE_ATTEMPT_MS = 38_000;
/* The look sheet is a list of named pieces, not an essay; it sits in the
   protected server block, so its size is taken from the trimmable part. */
const LOOK_SHEET_MAX_BYTES = 3_000;

/** Resolves null as soon as Abort is pressed; the shared work itself runs on. */
function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

type AnchorRequest = { runId: string; role: "source" | "follower"; force: boolean };

function parseAnchorRequest(v: unknown): AnchorRequest | null | "invalid" {
  if (v === undefined || v === null || v === false) return null;
  if (typeof v !== "object") return "invalid";
  const o = v as Record<string, unknown>;
  const role = o.role === "source" || o.role === "follower" ? o.role : null;
  if (!role || !isValidRunId(o.runId)) return "invalid";
  return { runId: o.runId, role, force: o.force === true };
}

/** Why panel 1 did not become an anchor, in the operator's words. */
function describeSourceFailure(panel: number, outcome: string, code: string): string {
  const p = `Panel ${panel || 1}`;
  if (outcome === "aborted" || code === "aborted") return `${p} was cancelled`;
  if (code === "back_unverified") return `${p} needs a Back photo (or the "back is plain" tick)`;
  if (code === "anchor_unavailable" || code === "anchor_flagged") return `${p} did not render`;
  if (outcome === "blocked") return `${p} was blocked by safety moderation`;
  if (/^ref_download/.test(code)) return `${p} could not download its reference photos`;
  if (code === "openai_auth" || code === "no_api_key") return `${p} could not reach OpenAI (API key)`;
  return `${p} did not render${code ? ` (${code})` : ""}`;
}

/**
 * The line that tells a follower what the attached panel 1 is. It sits after
 * the COLOURWAY block and before the side geometry, the pose variation, the
 * wearer-side mapping and the operator's final word, so the poses and the
 * operator are still read later than the anchor and win.
 */
function buildSameShootLine(args: {
  imageNumber: number;
  modelCount: number;
  stored: boolean;
  hasSpec: boolean;
  hasLookSheet: boolean;
}): string {
  const n = args.imageNumber;
  const identity = args.modelCount === 1 ? "image 1" : `images 1–${args.modelCount}`;
  return (
    `SAME-SHOOT REFERENCE — attached image ${n} (the last image) is ${
      args.stored
        ? "an approved panel from an earlier shoot of this product, on this model, in this colour"
        : "Panel 1 of THIS shoot, already rendered"
    }. It is not a product photo and not an identity photo. ` +
    `Match it exactly for everything that is NOT the product: the same top / bottom / outerwear / footwear / socks / accessories (same colour, cut, length, fit, tuck, cuff and roll), the same hair styling, the same light and white background.` +
    (args.hasLookSheet ? " Where it and the LOOK SHEET disagree about what is worn, the LOOK SHEET wins." : "") +
    ` For the product, match how it sits on this body in image ${n} (fit, length, drape) only where that agrees with the item photos${
      args.hasSpec ? " and the VERIFIED ITEM SPEC" : ""
    } — where they disagree, the item photos win. Identity comes from ${identity}. ` +
    `Never copy image ${n}'s poses, framing, crop or layout — this panel's poses are the ACTIVE POSE blocks and POSE VARIATION.`
  );
}

/** Which attached images are the FRONT and which are the BACK — so the
 *  generator can never copy a back print onto the front (or vice versa).
 *  Only emitted when the operator actually sorted photos into Front/Back. */
type ColorRun = { name: string; detail: string; refUrl: string; hardwareNote: string };

function parseColorOverride(v: unknown): ColorRun | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
  const name = s(o.name, 120);
  const refUrl = s(o.refUrl, 2048);
  if (!name && !refUrl) return null;
  // A data URL here would be re-uploaded on every panel of every run; the
  // Studio stores the photo first and sends the stored URL.
  return {
    name,
    detail: s(o.detail, 400),
    refUrl: /^https?:\/\//i.test(refUrl) ? refUrl : "",
    hardwareNote: s(o.hardwareNote, 600),
  };
}

/**
 * Put the new colourway into the spec's own Garment line.
 *
 * Only that line. The spec also says things like "STITCHING: matching dark grey
 * topstitch" and "HARDWARE: zip, black", and rewriting every colour word in it
 * would be a blunt instrument: "black" on a zip is the zip's own finish, not the
 * cloth, and turning it into "navy" would invent hardware nobody has seen. The
 * cloth colour is replaced here and the rule below tells the generator how to
 * read the rest.
 */
function applySpecColorOverride(spec: string, colorName: string): string {
  if (!spec || !colorName) return spec;
  const line = /^(\s*\d+\.\s*Garment:\s*[^—\n]*—\s*)([^\n]*?)(\.?\s*)$/m;
  if (line.test(spec)) return spec.replace(line, (_m, head: string, _old: string, tail: string) => `${head}${colorName}${tail}`);
  return `${spec}\nGARMENT COLOUR: ${colorName}.`;
}

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

/**
 * "Style with": the operator attached OTHER pieces for the model to wear with
 * the product — denim shorts styled with that shirt, those shoes and that
 * bracelet. They go to OpenAI after every product photo, so their numbers are
 * known from the counts alone, and they replace the default styling lock for
 * whatever they cover. Everything that keeps the product faithful (spec, view
 * map, back lock, QA) describes the product only and never sees them.
 */
function buildStylingRefLines(args: { modelCount: number; itemViews: ItemRefView[]; hasLookSheet?: boolean }): string[] {
  const styling = args.itemViews.filter((v) => v === "styling").length;
  if (!styling) return [];
  const productCount = args.itemViews.length - styling;
  const start = args.modelCount + productCount + 1;
  const range = styling === 1 ? `Attached image ${start} is` : `Attached images ${start}–${start + styling - 1} are`;
  return [
    `STYLE-WITH PIECES (SERVER — chosen by the operator; authoritative): ${range} OTHER clothing / footwear / accessories the model wears WITH the product in this shoot. They are NOT the product.`,
    "- The model wears every piece shown there, in every frame where that part of the body is in view, reproduced faithfully: the same colour, cut, fit, length, fabric, print, text and hardware as the photo shows.",
    "- Several photos of one piece (its front and its back, say) are ONE piece: worn once, with its front content on its front and its back content on its back.",
    args.hasLookSheet
      ? "- They are pieces of the LOOK SHEET below, which names each of them: reproduce each one from its photo here."
      : "- They REPLACE the STYLING LOCK and any outfit read from the product photos for whatever they cover: a top here replaces that top, shoes here replace that footwear, and jewellery, a belt, a bag or a hat here is worn even where the lock says no accessories. The lock still supplies only what these pieces do not cover.",
    "- The product is always worn and always the hero. A style-with piece never takes the product's place on the body, never covers its key details more than it naturally would, and never lends it a colour, print, text or detail — nor takes one from it. The item spec, the item view map and the garment-fidelity rules describe ONLY the product.",
    "- Any person, mannequin or hanger in a style-with photo is a display fixture: never copy a face, body, skin tone, hair or pose from it.",
  ];
}

/** Abort button: the operator cancelled this panel, so nothing more is spent on it. */
function abortedGenerateResponse() {
  return NextResponse.json(
    { error: { type: "aborted", code: "aborted", message: "Aborted — generation was cancelled." } },
    { status: 499 },
  );
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
async function POST_handler(req: NextRequest) {
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
  /* Abort pressed while this POST was still in transit: never start it. */
  if (isValidJobId(jobId) && takeEarlyCancel(jobId)) return abortedGenerateResponse();
  const bodyPromise = isValidJobId(jobId)
    ? runGenerateJob(jobId, async (signal) => (await handleGenerate(req, signal)).text())
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

/** `signal` = the Studio's Abort button (detached job runs only). */
async function handleGenerate(req: NextRequest, signal?: AbortSignal): Promise<Response> {
  // Wall clock for the generation log — OpenAI render time dominates it.
  const startedAt = Date.now();
  // Set once the request is parsed, so the outer catch can log what was asked for.
  let logCtx: (() => Omit<StudioGenerationLog, "outcome">) | null = null;
  /* Panel 1 of an anchored run: every exit settles it (see `finally`), so a
     follower is never left waiting on a source that already gave up. */
  let anchorSource: { runId: string; panel: number } | null = null;
  let anchorSourceSettled = false;
  let anchorSourceFailure = "";
  /* Studio night batch: build exactly the request Generate would send to
     OpenAI — same references, prompt, locks and settings — and hand it back
     instead of rendering it. The batch sends it later at half price
     (lib/server/studio-batch.ts). Nothing is charged and nothing is logged. */
  const prepareOnly = req.headers.get("x-generate-prepare") === "1";
  try {
    // WMS auth: authenticated admin session (replaces carbon-gen cookie auth).
    const session = await getSessionFromRequest(req);
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const authPool = getPool();
    if (!authPool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    const denied = await requireSessionScopes(authPool, session, [SCOPES.ADMIN]);
    if (denied) return denied;

    const {
      prompt: promptRaw,
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
      colorOverride,
      instruction: operatorInstructionRaw,
      anchor: anchorRaw,
      lookAnchorUrl: lookAnchorUrlRaw,
      lookSheet: lookSheetRaw,
      modelId: modelIdRaw,
      itemColour: itemColourRaw,
      jeansLabelId: jeansLabelIdRaw,
    } = await req.json();
    const prompt: unknown = typeof promptRaw === "string" ? toPanelLayout(promptRaw) : promptRaw;
    /* The operator's own words about this garment and this shoot. */
    const operatorInstruction =
      typeof operatorInstructionRaw === "string"
        ? operatorInstructionRaw.replace(/\s+/g, " ").trim().slice(0, 1200)
        : "";
    // Item refs sorted by view (Studio: General / Front / Back sections). The
    // image order sent to OpenAI is general → front → back so the prompt can
    // say which attached images are the front and which are the back.
    const parsedViewLists = parseItemRefViews(itemRefViews, itemRefs);
    /* Style-with photos past the sixth were always cut by parseItemRefViews;
       now the cut is logged with the rest of what was left out. */
    const stylingSent = Array.isArray((itemRefViews as { styling?: unknown } | null)?.styling)
      ? ((itemRefViews as { styling: unknown[] }).styling.filter((x) => typeof x === "string" && x.trim()).length)
      : 0;
    /* "Generate another colour": the same garment in a colourway we hold ONE
       photo of. The matrix spec stays in charge of construction, text,
       placement and the zone map — those do not change with the dye, and one
       phone photo could not overturn them anyway. Only the cloth colour is
       replaced, and the photo rides along as a reference so the render matches
       a real sample rather than a colour word. */
    const colorRun = parseColorOverride(colorOverride);
    if (colorRun?.refUrl) {
      parsedViewLists.general = [...parsedViewLists.general, colorRun.refUrl];
    }
    // Pre-generation item analysis (client → /api/openai/item-spec, possibly
    // edited by the operator). Appended INSIDE the server lock block and capped
    // so it can never push the prompt over the model limit.
    const itemSpecRaw =
      typeof itemSpec === "string" && itemSpec.trim()
        ? cutToBytes(
            applySpecColorOverride(
              itemSpec.trim().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n"),
              colorRun?.name ?? "",
            ),
            LOCK_TEXT_MAX_BYTES + 100,
          )
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
    const backPhotographed = parsedViewLists.back.length > 0;
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
    const itemSpecText = itemSpecRaw
      ? withInstructionFit(withCanonicalBackLine(itemSpecRaw, backState), operatorInstruction)
      : "";
    const normalizedPanelQa = normalizePanelQa(panelQa);
    /* Accessory shots are numbered 1-8 like poses but are not poses: Shot 4 is
       a clasp close-up, not "Pose 4, the back view". Every rule keyed on a
       pose number — the back lock, the side mapping, the pose variation —
       stands down for them. */
    const accessoryMode = Boolean(normalizedPanelQa.accessoryKind);
    /* Bottoms on a male model (owner's rules): Pose 4, the full-body back, ALWAYS
       has the top over the waistband — hard lock, label or not; Pose 7, the
       zoomed-in back crop, is the one frame that shows the label. */
    const bottomShoot = !accessoryMode && isLowerBodyProductCategory(String(normalizedPanelQa.itemType || ""));
    const femaleShoot = normalizedPanelQa.modelGender === "female";
    const maleBottomShoot = bottomShoot && !femaleShoot;
    const specBackLabel = specHasBackWaistbandLabelLine(itemSpecText);
    const poseSide = (pose: number) =>
      normalizedPanelQa.poseA === pose ? "LEFT" : normalizedPanelQa.poseB === pose ? "RIGHT" : null;
    /* The full-body back view keeps the top over the waistband: male Pose 4
       always (owner's hard lock); female Pose 2 when there is a back label for
       it to hide (only male Pose 7 ever shows the label). */
    const coverPose = maleBottomShoot ? 4 : bottomShoot && femaleShoot && specBackLabel ? 2 : null;
    const pose4Side = coverPose ? poseSide(coverPose) : null;
    const pose7Side = maleBottomShoot ? poseSide(7) : null;
    /* The single close-up (male 6, female 5) stays on the front of a bottom with a back label. */
    const closeUpPose = femaleShoot ? 5 : 6;
    const closeUpSide = bottomShoot && specBackLabel ? poseSide(closeUpPose) : null;
    /* The operator's jeans label (studio_jeans_labels, picked in the Studio for
       JEANS / DENIM SHORTS), for the panel holding Pose 7, and only when the
       spec itself puts a label on the back waistband. */
    let jeansLabelUrl = "";
    if (
      pose7Side &&
      typeof jeansLabelIdRaw === "string" &&
      UUID_RE.test(jeansLabelIdRaw) &&
      specHasBackWaistbandLabelLine(itemSpecText)
    ) {
      const r = await authPool
        .query<{ image_url: string }>(
          `SELECT image_url FROM studio_jeans_labels WHERE id = $1::uuid AND tenant_id = $2::uuid AND archived_at IS NULL`,
          [jeansLabelIdRaw, session.tid],
        )
        .catch(() => ({ rows: [] as { image_url: string }[] }));
      jeansLabelUrl = r.rows[0]?.image_url ?? "";
    }
    const backLockActive =
      !accessoryMode &&
      (isBackFacingPose(normalizedPanelQa.modelGender, normalizedPanelQa.poseA) ||
        isBackFacingPose(normalizedPanelQa.modelGender, normalizedPanelQa.poseB));
    /* Panel 1 sets the look — garment runs only. An accessory's panel 1 is
       product-only (no person, no outfit) and cannot anchor one; the Studio
       sends no anchor there, and one sent anyway is ignored. */
    const anchorParsed = accessoryMode ? null : parseAnchorRequest(anchorRaw);
    const anchorReq = anchorParsed === "invalid" ? null : anchorParsed;
    if (prepareOnly && anchorReq) {
      return NextResponse.json(
        { error: "A batch request cannot wait on a live panel 1 — send it without an anchor." },
        { status: 400 },
      );
    }
    if (anchorReq?.role === "source") {
      anchorSource = { runId: anchorReq.runId, panel: normalizedPanelQa.panelNumber ?? 1 };
    }
    /* A stored look ("Keep look") rides only on a panel outside a live
       anchored run. A source renders from the real references alone, so an
       anchor is never itself rendered from an anchor (depth 1), and a follower
       already gets this run's own panel 1. */
    const lookAnchorUrl =
      !accessoryMode && !anchorReq && typeof lookAnchorUrlRaw === "string" ? lookAnchorUrlRaw.trim() : "";
    const lookAnchorPath = lookAnchorUrl ? tryGetStoragePathFromUrl(lookAnchorUrl) : "";
    const matrixIdValid = typeof matrixId === "string" && UUID_RE.test(matrixId) ? matrixId : "";
    /* Same restriction style as /api/studio/ref-image: only this tenant's
       look anchors for THIS product, never the bucket at large. */
    const lookAnchorAllowed =
      Boolean(lookAnchorPath && matrixIdValid && UUID_RE.test(String(session.tid || ""))) &&
      lookAnchorPath.startsWith(lookAnchorPrefix(String(session.tid), matrixIdValid));
    const anchorRole: "source" | "follower" | "stored" | null = anchorReq?.role ?? (lookAnchorUrl ? "stored" : null);
    let anchorWaitMs: number | null = null;
    let anchorGate: string | null = null;
    /* The run's look, resolved once on the client (lib/studioLookSheet.ts) and
       sent identical in every panel body. Injected verbatim into the protected
       server block, so no panel can have it trimmed or reworded. */
    const lookSheet = typeof lookSheetRaw === "string" ? lookSheetRaw.replace(/\r\n?/g, "\n").trim() : "";
    const lookSheetBytes = lookSheet ? promptLen(lookSheet) : 0;
    const runTag = req.headers.get("x-generate-run")?.trim() ?? "";
    let imagesDropped: DroppedRefs = {};
    // Pose/expression variation: rotate by a per-generation seed so consecutive
    // shots never collapse to the same default pose/face. The Studio sends one
    // seed per run (a colourway keeps its stored one); without it (older
    // builders) the seed is time-derived per request.
    const seedSent =
      typeof variationSeed === "number"
        ? variationSeed
        : typeof variationSeed === "string" && variationSeed.trim()
          ? Number(variationSeed)
          : NaN;
    const resolvedVariationSeed = Number.isFinite(seedSent) ? Math.floor(seedSent) : Math.floor(Date.now() / 1000);

    /* "1536x1024" is no longer offered: anything still asking for it (a queued
       run, an old tab) gets the current panel size, matching toPanelLayout. */
    type ImageSize = "1024x1024" | "1024x1536" | typeof PANEL_SIZE;
    const allowedSizes = new Set<ImageSize>(["1024x1024", "1024x1536", PANEL_SIZE]);
    const finalSize =
      typeof size === "string" && allowedSizes.has(size as ImageSize)
        ? (size as ImageSize)
        : (PANEL_SIZE as ImageSize);
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
      anchorRole,
      anchorWaitMs,
      anchorGate,
      variationSeed: resolvedVariationSeed,
      lookSheetBytes: lookSheet ? lookSheetBytes : null,
      imagesDropped: Object.keys(imagesDropped).length ? imagesDropped : null,
      runTag: isValidRunId(runTag) ? runTag : null,
    });
    logCtx = logBase;
    const logged = <T,>(entry: Partial<StudioGenerationLog> & { outcome: StudioGenerationLog["outcome"] }, response: T): T => {
      if (entry.outcome !== "ok") {
        anchorSourceFailure = describeSourceFailure(anchorSource?.panel ?? 1, entry.outcome, String(entry.errorCode || ""));
      }
      recordStudioGeneration({ ...logBase(), ...entry });
      return response;
    };

    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }
    if (anchorParsed === "invalid") {
      return NextResponse.json(
        {
          error: {
            type: "invalid_anchor",
            code: "invalid_anchor",
            message: 'anchor must be { runId, role: "source" | "follower", force? } with a valid run id.',
          },
        },
        { status: 400 },
      );
    }
    if (lookAnchorUrl && !lookAnchorAllowed) {
      return NextResponse.json(
        {
          error: {
            type: "invalid_look_anchor",
            code: "invalid_look_anchor",
            message: "That stored look is not one of this product's saved looks. Turn off Keep look, or render panel 1 again.",
          },
        },
        { status: 400 },
      );
    }
    if (lookSheetBytes > LOOK_SHEET_MAX_BYTES) {
      return NextResponse.json(
        {
          error: {
            type: "look_sheet_too_large",
            code: "look_sheet_too_large",
            message: `The look sheet is ${lookSheetBytes} bytes; the limit is ${LOOK_SHEET_MAX_BYTES}. Shorten the outfit lines and generate again.`,
          },
        },
        { status: 400 },
      );
    }

    /* The label photo rides with the Pose 7 panel as one more image. */
    const labelAttach = Boolean(jeansLabelUrl);

    const modelRefValues = Array.isArray(modelRefs) ? modelRefs : [];
    const modelRefNormalization = normalizeReferenceUrls(modelRefValues, "Model");
    /* Inside the 16-image limit before anything is downloaded; the anchor's
       slot is reserved here too, since it is attached after the downloads. */
    const capped = capReferenceImages({
      modelCount: modelRefNormalization.urls.length,
      lists: parsedViewLists,
      hasColorPhoto: Boolean(colorRun?.refUrl),
      anchorSlots: (anchorRole === "follower" || anchorRole === "stored" ? 1 : 0) + (labelAttach ? 1 : 0),
    });
    const viewLists = capped.lists;
    /* Appended LAST among the general photos, so its position in the item list
       is known without matching URLs back after normalisation. */
    const colorAnchorIdx = colorRun?.refUrl ? viewLists.general.length - 1 : -1;
    {
      const dropped: DroppedRefs = { ...capped.dropped };
      for (let n = MAX_STYLING_REFS + 1; n <= stylingSent; n += 1) (dropped.styling ??= []).push(n);
      imagesDropped = dropped;
    }
    // Style-with pieces go LAST, after every product photo (buildStylingRefLines counts on it).
    const itemRefValues = [...viewLists.general, ...viewLists.front, ...viewLists.back, ...viewLists.styling];
    const itemRefViewTags: ItemRefView[] = [
      ...viewLists.general.map((): ItemRefView => "general"),
      ...viewLists.front.map((): ItemRefView => "front"),
      ...viewLists.back.map((): ItemRefView => "back"),
      ...viewLists.styling.map((): ItemRefView => "styling"),
    ];
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
    if (!normalizedItemRefs.length || normalizedItemRefs.length === viewLists.styling.length) {
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
    const poseVariationDirective = accessoryMode ? "" : buildPoseVariationDirective({
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
    /*
     * "Inner" is a position, not a disappearing act.
     *
     * The Evening Pants carry a zip up the INNER side of each ankle, which the
     * photographs show plainly: a slim closed seam with a small pull, on the
     * edge of each leg that faces the other leg. The prompt used to tell the
     * model that a placement called INNER or CONCEALED "stays out of sight …
     * never surfacing on the outside of the garment", which asks for something
     * impossible — a visible detail that must not be visible. Given an
     * impossible instruction the model fell back on how these trousers are
     * usually made, and put the zip on the OUTER ankle, run after run.
     *
     * So the two ideas are separated and both are spelled out as geometry:
     * INNER names which edge, CONCEALED names the finish, and neither means
     * leave it out. Only emitted when a side or finish word actually appears,
     * so garments it cannot help do not pay for it.
     */
    /* A rule placed far from the line it governs loses to the line. That is how
       the hardware rule lost to the back lock, so the clarification goes INTO
       the spec line the model is copying, not only into a rule below it. */
    const clarifySideWords = (spec: string): string =>
      spec
        .split("\n")
        .map((line) =>
          /\b(hardware|zone|zip|zipper|pocket|stitch|seam|vent|slit)\b/i.test(line)
            ? line.replace(
                /\b(inner|inside|medial|inseam)\b/gi,
                "$1 (the edge that faces the other leg, beside the gap between the legs — never the outer edge)",
              )
            : line,
        )
        .join("\n");
    /*
     * Do not ask the image model which side of the picture "the wearer's left"
     * lands on. It gets it wrong.
     *
     * The analyser side of this is now right: the spec says "chain … the
     * wearer's left belt loop", which matches the garment. The renders still
     * put the chain on the wearer's RIGHT in five frames of eight. Telling it
     * the rule ("the wearer's left appears on the right of a front-facing
     * frame") did not fix it, and probably made it worse — the sentence
     * contains the word "left", and a diffusion model reading "left" near a
     * placement tends to draw on the left of the canvas.
     *
     * We already know everything needed to remove the question. The panel's
     * two poses are fixed, and isBackFacingPose() says which way the model
     * faces in each. So the mapping is computed here, per frame, and the
     * prompt states the side of the PICTURE to draw on. No anatomy, no mirror,
     * nothing left to infer.
     */
    const frameSideLine = (pose: number | null, half: "LEFT" | "RIGHT"): string => {
      const back = isBackFacingPose(normalizedPanelQa.modelGender, pose);
      const poseLabel = pose ? `Pose ${pose}` : "that pose";
      return back
        ? `  • ${half} half (${poseLabel}, seen from BEHIND): "the wearer's left" = the LEFT-hand side of that half; "the wearer's right" = the RIGHT-hand side.`
        : `  • ${half} half (${poseLabel}, facing the camera): "the wearer's left" = the RIGHT-hand side of that half; "the wearer's right" = the LEFT-hand side.`;
    };
    /* One concrete detail from the spec, named, so the mapping is not abstract.
       `face` is the side of the garment its line puts it on: a front-only detail
       (Los Angeles Shirt's hem stars, 2026-10-22) was being placed in the
       back-facing half too, because this line gave it a side in every frame. */
    const firstSidedDetail = (() => {
      for (const line of itemSpecText.split("\n")) {
        const m = /^\s*\d+\.\s*[A-Z/ —-]+(?:\([^)]*\))?:\s*([^,.]+)[^]*?the wearer's ([Ll]eft|LEFT|[Rr]ight|RIGHT)/.exec(line);
        if (!m) continue;
        const front = /\bfront\b/i.test(line), back = /\bback\b(?!\s+(?:view|pose))/i.test(line.replace(/\b(?:no|not|never)\b[^.;]*\bback\b/gi, ""));
        const face: "front" | "back" | null = front && !back ? "front" : back && !front ? "back" : null;
        return { what: m[1].trim().toLowerCase(), side: m[2].toLowerCase() as "left" | "right", face };
      }
      return null;
    })();
    const sidedDetailInHalf = (pose: number | null, half: "LEFT" | "RIGHT"): string => {
      const d = firstSidedDetail!;
      const backFacing = isBackFacingPose(normalizedPanelQa.modelGender, pose);
      if (d.face === "front" && backFacing) return `does NOT appear in the ${half} half at all (that frame is seen from behind and it is a front detail)`;
      if (d.face === "back" && !backFacing) return `does NOT appear in the ${half} half at all (that frame faces the camera and it is a back detail)`;
      return `goes on the ${backFacing === (d.side === "left") ? "LEFT" : "RIGHT"}-hand side of the ${half} half`;
    };
    const wearerSideFrameLines = !accessoryMode && /the wearer's (left|right)/i.test(itemSpecText)
      ? [
          "- WHICH SIDE OF THE PICTURE TO DRAW ON. Every \"the wearer's left\" and \"the wearer's right\" above has already been converted for you, per frame, below. Use these lines literally and do not work it out again. In particular do NOT read the word \"left\" as the left of the picture — read the mapping:",
          frameSideLine(normalizedPanelQa.poseA ?? null, "LEFT"),
          frameSideLine(normalizedPanelQa.poseB ?? null, "RIGHT"),
          ...(firstSidedDetail
            ? [
                `  So the ${firstSidedDetail.what} (spec says the wearer's ${firstSidedDetail.side}${
                  firstSidedDetail.face ? `, on the ${firstSidedDetail.face.toUpperCase()} of the garment` : ""
                }) ${sidedDetailInHalf(normalizedPanelQa.poseA ?? null, "LEFT")}, and ${sidedDetailInHalf(normalizedPanelQa.poseB ?? null, "RIGHT").replace(/^goes on/, "on")}.`,
              ]
            : []),
          "  It is the same hip, shoulder or leg of the same body in every frame of this run — it changes side of the picture only because the model has turned around. Never mirror it for any other reason.",
        ]
      : [];

    const sideWordSource = `${itemSpecText}\n${typeof prompt === "string" ? prompt : ""}`;
    const sidePlacementLines = !accessoryMode && /\b(inner|inside|medial|inseam|outer|lateral|concealed|hidden|invisible|left|right)\b/i.test(
      sideWordSource,
    )
      ? [
          "- SIDE WORDS ARE GEOMETRY, NOT VISIBILITY. INNER / INSIDE / MEDIAL / INSEAM means the side of that limb which FACES THE OTHER LIMB, on the OUTER SURFACE of the fabric, fully visible in the picture. With both legs in frame, two inner details are the pair CLOSEST TOGETHER — one each side of the gap between the legs, mirroring each other across it. The far edge of each leg, the edge nearest the edge of the picture, carries NOTHING. Check it before you finish: if the two details sit far apart, one near each outside edge of the frame, they are on the wrong sides and must be mirrored inward. OUTER / LATERAL means that far edge, and a line saying INNER never puts anything there.",
          "- CONCEALED / HIDDEN / INVISIBLE describes a FINISH, never a reason to leave something out or move it. A concealed zip is present and visible as a slim closed seam with its small pull, simply with no exposed teeth. Draw it where its line says, at the size its line says.",
          "- Where this garment places a detail differently from how such garments are usually made, THIS garment wins. An ankle zip on the outer leg, a crease down the front, a pocket where there is none: the convention is not evidence, and copying it is an invention.",
        ]
      : [];

    /* What the back waistband shows in this panel, said inside the spec and back
       lines that would otherwise ask for the label in every back frame. */
    const waistbandCarves = [
      ...(pose4Side ? [`in ${pose4Side} Pose ${coverPose} the top hangs over the waistband, so the label or patch on the back of the waistband is hidden under it there`] : []),
      ...(labelAttach && pose7Side
        ? [`in ${pose7Side} Pose 7 the back-waistband label is copied exactly from the attached label photo (BACK-WAISTBAND LABEL line)`]
        : []),
    ];
    const waistbandBackCarve = waistbandCarves.length ? ` The back waistband: ${waistbandCarves.join("; ")}.` : "";
    const waistbandTextCarve = waistbandCarves.length ? ` The exception is the back-waistband label: ${waistbandCarves.join("; ")}.` : "";

    const buildServerLockBlock = (
      modelCount: number,
      itemViewMapLines: string[],
      stylingRefLines: string[],
      sameShootLines: string[],
      labelLines: string[] = [],
    ) => [
      buildServerLockPrompt(normalizedPanelQa, modelCount),
      ...itemViewMapLines,
      ...stylingRefLines,
      ...(itemSpecText
        ? [
            "VERIFIED ITEM SPEC (read off the item photos — every line MUST appear exactly as stated, in every frame and every panel. It overrides generic styling, but NOT the ITEM INSTRUCTION above: that was written by the person holding the garment, so where the two disagree about a placement, finish or fit, the instruction wins and this line yields):",
            clarifySideWords(itemSpecText),
            `- Every TEXT line is rendered letter-perfect (words, spelling, case, letterforms, colour, size) at its listed placement and side only — never a back print on the front or vice versa, never merged or swapped words, never extra text. Print effects (blurred / ghosted / faded / gradient / halftone / cracked) are part of the design and are rendered as such, never as a crisp clean version. The FIT/SILHOUETTE line is absolute: oversized reads clearly oversized, slim stays slim. HARDWARE / STITCHING / POCKET / MATERIAL lines match in kind, count, colour, finish and position. Anything NOT CLEARLY VISIBLE stays plain — never invented.${waistbandTextCarve}`,
            "- A PIECE OF HARDWARE KEEPS THE FORM ITS LINE GIVES IT, AT THE SIZE ITS LINE GIVES IT, IN EVERY FRAME THAT SHOWS IT — full-body frames included. A button described with a diameter, a hole count and a size against its waistband is drawn that big with those holes, not shrunk into the small plain disc these garments usually have; the same goes for the way a waistband fastens, a tab that reaches past the fly, the shape of a zip pull and the links of a chain. Far away it may be less sharp. It is never a simpler object.",
            "- Small chest / sleeve / neck text keeps its true garment size but is still spelled letter-perfect in crisp, clean letterforms, even in full-body frames — never pseudo-letters, scribbles or a smudge.",
            "- A ZONE line is a complete account of that part of the garment: build it exactly as written and add nothing else there. Where a ZONE line says a zone is flat, plain or has none, that zone STAYS empty — no crease, no pleat, no pocket, no stripe, no topstitch that the line does not name.",
            ...(accessoryMode ? [] : buildBackStateLine(backState, normalizedPanelQa, itemSpecText, waistbandBackCarve)),
          ]
        : accessoryMode ? [] : buildBackStateLine(backState, normalizedPanelQa, itemSpecText, waistbandBackCarve)),
      buildBrandSafetyLock(normalizedPanelQa.itemType),
      /* THE LOOK SHEET: what is worn, resolved once for the whole run and
         byte-identical in every panel. It comes after the product (the spec)
         and the coverage floor (brand safety) — styling never outranks
         either — and before the colourway, the same-shoot reference, the
         poses and the operator, which all still read later and win. */
      ...(lookSheet ? [/^LOOK SHEET\b/i.test(lookSheet) ? lookSheet : `LOOK SHEET (SERVER — resolved once for this whole shoot; the same in every panel):\n${lookSheet}`] : []),
      ...(colorRun
        ? [
            `COLOURWAY — this run renders the SAME product in a different colour: ${
              colorRun.name || "the colour in the colour reference photo"
            }.${colorRun.detail ? ` ${colorRun.detail}` : ""}`,
            ...(colorImageNumber
              ? [
                  `- Attached image ${colorImageNumber} is a photograph of THIS colourway. Take the colour from it: match the cloth's lightness, saturation, undertone and surface the way that photo shows them, not a generic idea of the colour's name. Take nothing else from it — it is a colour swatch, not a second opinion on how the garment is built.`,
                ]
              : [
                  `- No photograph of this colourway reached the renderer, so the colour comes from its name alone. Keep it plain and even; do not invent a wash, a fade or a pattern.`,
                ]),
            "- The CLOTH is this colour everywhere it appears: front, back, legs, sleeves, waistband, collar, cuffs and hem. Where a line below names the old colour for the fabric, read it as this colour instead.",
            "- HARDWARE, TRIM AND STITCHING KEEP THE COLOURS THEIR OWN LINES GIVE THEM. A zip the spec calls black stays black; topstitch the spec calls matching follows the NEW cloth colour, because that is what matching means.",
            ...(colorRun.hardwareNote ? [`- Checked on the colourway photo: ${colorRun.hardwareNote}`] : []),
            "- Everything else is unchanged: same cut, same fit, same seams, same pockets, same hardware in the same places, same text and graphics at the same size and position. This is a dye change, not a redesign.",
          ]
        : []),
      ...sameShootLines,
      ...sidePlacementLines,
      ...(poseVariationDirective ? [poseVariationDirective] : []),
      /* LAST, deliberately. The pose-variation directive just above carries its
         own "hip shift slightly left" / "toe-out right foot" wording, and a
         diffusion model weights what it read most recently. Panel 1 came back
         with the chain on opposite hips in its two frames while this mapping
         sat above all that; it now has the last word. */
      ...wearerSideFrameLines,
      /* THE LAST WORD, and it belongs to the operator.
         The instruction used to sit in the middle of the client prompt with
         authority only over the garment spec. Everything after it — the
         styling lock, the outfit, the colourway, the side mapping, the pose
         variation — was read later and carried more weight, so an instruction
         like "style with black leather trousers" or "cuffs rolled once" lost to
         whatever came last. This session has shown more than once that the most
         recent and the most specific line wins; the operator's instruction is
         now both. It sits in this server block, which is never trimmed. */
      ...(operatorInstruction
        ? [
            `OPERATOR INSTRUCTION — FINAL WORD: "${operatorInstruction}". Written by the person holding this garment and publishing these photos. It outranks EVERY line above: the item spec, ${
              lookSheet ? "the look sheet" : "the styling lock, the outfit from the photos"
            }, the colourway, ${
              sameShootLines.length ? "the same-shoot reference, " : ""
            }the side directions, the pose directions and the background. Where it disagrees with any of them, do what it says and drop the conflicting part. Where it says nothing, everything above still applies.`,
          ]
        : []),
      /* The owner's hard locks on the back waistband, after everything — the
         operator included — because nothing may undo them. */
      ...(pose4Side && coverPose ? [buildBackCoverLine(pose4Side, coverPose, String(normalizedPanelQa.itemType || ""))] : []),
      ...(pose7Side ? [buildPose7CoverLine(pose7Side, specBackLabel)] : []),
      ...(closeUpSide
        ? [buildCloseUpFrontLine(closeUpSide, closeUpPose, String(normalizedPanelQa.itemType || ""), maleBottomShoot ? 7 : null)]
        : []),
      ...labelLines,
    ].join("\n");

    // Keep model identity anchors bounded (≤6, fewer when the 16-image cap needed the room).
    const modelAnchors = normalizedModelRefs.slice(0, capped.modelKeep);
    const itemAnchors = normalizedItemRefs;
    // View tag per item anchor; if normalisation changed the count (it only
    // drops on error, which 400s above) fall back to "general" for all.
    const itemAnchorViews: ItemRefView[] =
      itemRefViewTags.length === itemAnchors.length ? itemRefViewTags : itemAnchors.map((): ItemRefView => "general");

    if (signal?.aborted) return logged({ outcome: "aborted", errorCode: "aborted" }, abortedGenerateResponse());

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
    /* Style-with photos alone are not the product: at least one PRODUCT photo must have arrived. */
    const productFilesCount = itemRefViewsForQa.filter((v) => v !== "styling").length;

    /* Which attached image is the colourway photo, counted the way the view map
       counts: model refs first, then the item photos that actually downloaded.
       A photo that failed to download is a photo the model never saw, so if the
       colour ref is the one that failed we say nothing about it rather than
       pointing at somebody else's picture. */
    const colorImageNumber = (() => {
      if (colorAnchorIdx < 0) return 0;
      const slot = downloaded[modelAnchors.length + colorAnchorIdx];
      if (!slot || slot.status !== "fulfilled") return 0;
      const okBefore = downloaded
        .slice(modelAnchors.length, modelAnchors.length + colorAnchorIdx)
        .filter((r) => r.status === "fulfilled").length;
      return modelFilesCount + okBefore + 1;
    })();

    if (!referenceFiles.length || modelFilesCount === 0 || itemFilesCount === 0 || productFilesCount === 0) {
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

    /* A product photo — or a style-with piece — that failed to download used
       to drop out of THIS panel only: the other panels of the run rendered with
       it, this one without, and the view map was renumbered around the hole.
       That is a different garment truth (or outfit) in one panel. Now the
       panel fails before anything is paid for and says which photo. */
    const failedItems = downloaded
      .slice(modelAnchors.length)
      .map((r, i) => ({ r, i }))
      .filter((e): e is { r: PromiseRejectedResult; i: number } => e.r.status === "rejected");
    if (failedItems.length) {
      const VIEW_LABEL: Record<ItemRefView, string> = { general: "General", front: "Front", back: "Back", styling: "Style with" };
      const failed = failedItems.map(({ i }) => {
        const view = itemAnchorViews[i] ?? "general";
        const position = itemAnchorViews.slice(0, i + 1).filter((v) => v === view).length;
        return {
          view,
          position,
          label: i === colorAnchorIdx ? "the colourway photo" : `${VIEW_LABEL[view]} photo ${position}`,
        };
      });
      const names = failed.map((f) => f.label);
      const one = names.length === 1;
      const reasons = failedItems.map((e) => String((e.r.reason as Error)?.message || e.r.reason || "")).join(" | ");
      return logged(
        {
          outcome: "failed",
          errorCode: "ref_download_failed",
          errorMessage: `${names.join(", ")}: ${reasons}`,
          modelRefCount: modelFilesCount,
          itemRefCount: itemFilesCount,
        },
        NextResponse.json(
          {
            error: {
              type: "ref_download_failed",
              code: "ref_download_failed",
              message: `${names.join(", ")} could not be downloaded, so this panel was not rendered and nothing was charged for it. Re-upload ${
                one ? "that photo (or remove it)" : "those photos (or remove them)"
              } and generate again.`,
              failed: failed.map(({ view, position }) => ({ view, position })),
            },
          },
          { status: 400 },
        ),
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

    /* The judges check the PRODUCT against its photos. Style-with pieces are
       styling — showing them as product references would read as a mismatch. */
    const qaItemIdx = itemRefViewsForQa.map((v, i) => (v === "styling" ? -1 : i)).filter((i) => i >= 0);
    const qaItemRefs = qaItemIdx.map((i) => itemRefDataUrls[i]);
    const qaItemViews = qaItemIdx.map((i) => itemRefViewsForQa[i] as Exclude<ItemRefView, "styling">);

    /* ── Panel 1 sets the look ──────────────────────────────────────────────
       A follower has its references; now it waits for panel 1 (on the server,
       so resume, Abort and the job ids are exactly as before), gates it once
       per run, and attaches it LAST, so no image number above changes. Every
       way this can fail answers before any OpenAI call. */
    const refCounts = { modelRefCount: modelFilesCount, itemRefCount: itemFilesCount };
    const anchorUnavailable = (code: string, message: string) =>
      logged(
        { ...refCounts, outcome: "blocked", errorCode: "anchor_unavailable", errorMessage: `${code}: ${message}` },
        NextResponse.json({ error: { type: "anchor_unavailable", code, message } }, { status: 409 }),
      );
    let anchorFile: Awaited<ReturnType<typeof toFile>> | null = null;
    if (anchorRole === "follower" && anchorReq) {
      const runId = anchorReq.runId;
      /* "Render the others anyway" comes after panel 1 finished: if the server
         no longer holds it (it is kept 15 minutes, and a restart loses it),
         waiting for it would only run out the clock. */
      if (anchorReq.force && !peekRunAnchor(runId)) {
        return anchorUnavailable(
          "anchor_expired",
          "Panel 1 of this run is no longer held on the server, so this panel was not rendered and nothing was charged for it. Regenerate panel 1.",
        );
      }
      const waitStarted = Date.now();
      const waited = await waitRunAnchor(runId, {
        signal,
        timeoutMs: Math.min(ANCHOR_WAIT_MAX_MS, startedAt + FOLLOWER_WINDOW_MS - MIN_RENDER_WINDOW_MS - Date.now()),
      });
      anchorWaitMs = Date.now() - waitStarted;
      if (waited.status === "aborted" || signal?.aborted) {
        return logged({ ...refCounts, outcome: "aborted", errorCode: "aborted" }, abortedGenerateResponse());
      }
      if (waited.status === "timeout") {
        return anchorUnavailable(
          "anchor_timeout",
          `Panel 1 did not finish in time, so this panel was not rendered and nothing was charged for it. Render this panel again.`,
        );
      }
      if (waited.status === "failed") {
        return anchorUnavailable(
          "anchor_failed",
          `${waited.reason}, so this panel was not rendered and nothing was charged for it. Fix panel 1 and generate again.`,
        );
      }
      if (anchorReq.force) {
        /* "Render the other panels anyway": the operator looked at panel 1. */
        anchorGate = "forced";
        void markLookAnchorGate(matrixIdValid, runId, "forced");
      } else {
        const gateWork = async (): Promise<AnchorGateResult> => {
          const result = await withTimeout(
            runAnchorGate({
              openai,
              panel: { panel: waited.panel, poseA: waited.poseA, poseB: waited.poseB, b64: waited.b64, logId: null },
              itemRefs: qaItemRefs,
              itemRefViews: qaItemViews,
              modelRefs: modelRefDataUrls,
              itemSpec: itemSpecText,
              itemType: String(normalizedPanelQa.itemType || ""),
              colorName: colorRun?.name ?? "",
              instruction: operatorInstruction,
              modelGender: normalizedPanelQa.modelGender,
              timeoutMs: ANCHOR_GATE_ATTEMPT_MS,
            }),
            ANCHOR_GATE_MAX_MS,
            "Panel 1 accuracy gate",
          ).catch((): AnchorGateResult => ({ status: "unavailable", findings: [], notes: [] }));
          void markLookAnchorGate(matrixIdValid, runId, result.status);
          return result;
        };
        const gate = await untilAborted(gateRunAnchor(runId, gateWork), signal);
        if (!gate) return logged({ ...refCounts, outcome: "aborted", errorCode: "aborted" }, abortedGenerateResponse());
        anchorGate = gate.status;
        if (gate.status === "flagged") {
          return logged(
            {
              ...refCounts,
              outcome: "blocked",
              errorCode: "anchor_flagged",
              errorMessage: gate.findings.map((f) => f.text).join(" | ").slice(0, 600),
            },
            NextResponse.json(
              {
                error: {
                  type: "anchor_flagged",
                  code: "anchor_flagged",
                  message: `The check flagged panel ${waited.panel}, so this panel was held before anything was paid for. Look at panel ${waited.panel}'s flags, then render the other panels anyway or regenerate panel ${waited.panel}.`,
                  sourcePanel: waited.panel,
                  findings: gate.findings,
                  notes: gate.notes,
                },
              },
              { status: 409 },
            ),
          );
        }
      }
      /* The wait and the gate came out of the Studio's polling window. */
      if (startedAt + FOLLOWER_WINDOW_MS - Date.now() < MIN_RENDER_WINDOW_MS) {
        return anchorUnavailable(
          "anchor_timeout",
          `Panel 1 and its check took too long to leave time for this panel, so it was not rendered and nothing was charged for it. Render this panel again.`,
        );
      }
      anchorFile = await toFile(Buffer.from(waited.b64, "base64"), "same-shoot-panel-1.png", { type: "image/png" });
    } else if (anchorRole === "stored") {
      try {
        const { body, contentType } = await withTimeout(
          downloadStorageObject(lookAnchorPath),
          getImageFetchTimeoutMs(),
          "Stored look download",
        );
        const type = (contentType || "").split(";")[0].trim().toLowerCase();
        if (!/^image\/(png|jpe?g|webp)$/.test(type)) throw new Error(`unsupported type ${type || "none"}`);
        anchorFile = await toFile(Buffer.from(body), `same-shoot-look.${extFromContentType(type)}`, { type });
      } catch (e) {
        console.warn(`[generate] stored look not loaded (${lookAnchorPath}):`, (e as Error)?.message || e);
        return anchorUnavailable(
          "look_anchor_missing",
          "The saved look for this model and colour could not be loaded, so this panel was not rendered and nothing was charged for it. Turn off Keep look, or render panel 1 again.",
        );
      }
    }

    /* The jeans label photo rides after the references and before the
       same-shoot anchor, so every image number above it is unchanged. A label
       that will not download stops the panel: rendering on would draw an
       invented patch. */
    let labelFile: Awaited<ReturnType<typeof toFile>> | null = null;
    if (jeansLabelUrl) {
      try {
        labelFile = (await downloadReferenceAsFile(jeansLabelUrl, referenceFiles.length)).file;
      } catch (e) {
        return logged(
          { ...refCounts, outcome: "failed", errorCode: "ref_download_failed", errorMessage: `jeans label: ${(e as Error)?.message || e}` },
          NextResponse.json(
            {
              error: {
                type: "ref_download_failed",
                code: "ref_download_failed",
                message:
                  "The jeans label photo could not be downloaded, so this panel was not rendered and nothing was charged for it. Pick the label again (or another one) and generate again.",
                failed: [],
              },
            },
            { status: 400 },
          ),
        );
      }
    }
    const labelLines = labelFile && pose7Side ? [buildJeansLabelLine(referenceFiles.length + 1, pose7Side)] : [];
    const sameShootLines = anchorFile
      ? [
          buildSameShootLine({
            // Attached LAST: every image number above is unchanged.
            imageNumber: referenceFiles.length + (labelFile ? 1 : 0) + 1,
            modelCount: modelFilesCount,
            stored: anchorRole === "stored",
            hasSpec: Boolean(itemSpecText),
            hasLookSheet: Boolean(lookSheet),
          }),
        ]
      : [];
    const editImages = [...referenceFiles, ...(labelFile ? [labelFile] : []), ...(anchorFile ? [anchorFile] : [])];
    const serverLockBlock = buildServerLockBlock(
      modelFilesCount,
      buildItemViewMapLines({ modelCount: modelFilesCount, itemViews: itemRefViewsForQa }),
      buildStylingRefLines({ modelCount: modelFilesCount, itemViews: itemRefViewsForQa, hasLookSheet: Boolean(lookSheet) }),
      sameShootLines,
      labelLines,
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
    let b64: string | null = null;
    let imageUsage: Record<string, unknown> | null = null;
    const logRefs = { ...refCounts, promptBytes: promptLen(lockedPrompt), promptTrimmed: clamped.trimmed };
    if (prepareOnly) {
      const images = await Promise.all(
        editImages.map(async (f, i) => {
          const file = f as unknown as { name?: string; type?: string; arrayBuffer: () => Promise<ArrayBuffer> };
          return {
            name: file.name || `ref-${i + 1}.png`,
            type: file.type || "image/png",
            b64: Buffer.from(await file.arrayBuffer()).toString("base64"),
          };
        }),
      );
      return NextResponse.json({
        prepared: {
          model: imageModel,
          prompt: enforcePromptLength(lockedPrompt),
          size: finalSize,
          quality: imageQuality,
          moderation: imageModeration,
          images,
        },
        meta: {
          ...logRefs,
          imageQuality,
          imageSize: finalSize,
          backState,
          specConfirmed: specConfirmed === true,
          specBytes: promptLen(itemSpecText),
          variationSeed: resolvedVariationSeed,
          ...(clamped.trimmed ? { promptOverflowBytes } : {}),
          ...(Object.keys(imagesDropped).length ? { imagesDropped } : {}),
        },
      });
    }
    try {
      // Only the configured model — never silently substitute a different
      // (paid) model. No input_fidelity: on gpt-image edits it forces faithful
      // reproduction of the faces in ALL input images — including any person
      // wearing the garment in the ITEM references — and gpt-image-2 rejects
      // the parameter outright. Identity is held by the prompt's model-ref line.
      /*
       * A dropped connection is not a failed generation.
       *
       * Panels 2 and 3 of a four-panel run came back "terminated" at ~100 s,
       * which is undici's wording for a response socket closed mid-flight. The
       * other two panels of the same run, same prompt size, same moment,
       * finished normally. Nothing was wrong with the request: the connection
       * died while the finished image was coming back, and the operator lost
       * half the run and had to pay for all of it again.
       *
       * The OpenAI SDK retries request-level failures, but a failure while
       * reading the response body surfaces as a bare TypeError and escapes it,
       * so transient network faults are retried here. Deterministic failures —
       * a moderation block, a bad key, our own timeout — are never retried:
       * they would fail the same way and burn another 90 s of the operator's
       * five-minute window.
       */
      const attemptsAllowed = Math.max(1, Math.min(3, Number(process.env.OPENAI_IMAGE_ATTEMPTS) || 2));
      /* The browser stops polling at five minutes; stay inside that or a retry
         produces an image nobody is still waiting for. Taken NOW, after any
         wait for panel 1 — otherwise the wait would eat the render's budget —
         and for a follower also inside the Studio's longer anchored window,
         which the wait has already used part of. */
      const renderBudgetEnd = Date.now() + Math.min(imageTimeoutMs + 60_000, 285_000);
      const overallDeadline =
        anchorRole === "follower" ? Math.min(renderBudgetEnd, startedAt + FOLLOWER_WINDOW_MS) : renderBudgetEnd;
      let imageErr: any = null;
      for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
        if (signal?.aborted) break;
        const remaining = overallDeadline - Date.now();
        try {
          const edited = await withTimeout(
            openai.images.edit(
              {
                model: imageModel,
                image: editImages,
                prompt: enforcePromptLength(lockedPrompt),
                size: finalSize,
                quality: imageQuality as any,
                moderation: imageModeration as any,
              } as any,
              // Abort button: cancels the request to OpenAI mid-render.
              { signal },
            ),
            Math.max(30_000, Math.min(imageTimeoutMs, remaining)),
            "OpenAI image generation"
          );
          b64 = edited.data?.[0]?.b64_json ?? null;
          /* What the render cost, in tokens — kept so cost stops being an estimate. */
          const usage = (edited as any)?.usage;
          imageUsage = usage && typeof usage === "object" ? (usage as Record<string, unknown>) : null;
          imageErr = null;
          break;
        } catch (e: any) {
          imageErr = e;
          const left = overallDeadline - Date.now();
          /* A generation takes ~90 s; retrying with less than that left just
             swaps one failure for a slower one. */
          if (signal?.aborted || attempt >= attemptsAllowed || !isTransientNetworkError(e) || left < 95_000) break;
          console.warn(
            `[generate] panel ${normalizedPanelQa.panelNumber ?? "?"}: ${String(
              e?.message || e,
            )} — connection fault on attempt ${attempt}/${attemptsAllowed}, ${Math.round(
              left / 1000,
            )}s left, retrying.`,
          );
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      if (signal?.aborted) {
        return logged({ ...logRefs, outcome: "aborted", errorCode: "aborted" }, abortedGenerateResponse());
      }
      if (imageErr) throw imageErr;
    } catch (err: any) {
      if (signal?.aborted) {
        return logged({ ...logRefs, outcome: "aborted", errorCode: "aborted" }, abortedGenerateResponse());
      }
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

    /* Panel 1 is in: release every follower waiting on it NOW, before the
       stash, the log or the R2 upload below. */
    const source = anchorSource;
    if (source) {
      settleRunAnchor(source.runId, {
        status: "ok",
        b64: await workingCopy(b64),
        panel: source.panel,
        poseA: normalizedPanelQa.poseA,
        poseB: normalizedPanelQa.poseB,
      });
      anchorSourceSettled = true;
    }

    /* Run-level QA. The judge used to run once per panel, and a panel seen on
       its own cannot answer the question the operator actually has: are these
       eight pictures the same outfit on the same person? Each panel is stashed
       here as it lands, with the references already resolved for this request,
       and the Studio asks /api/generate/run-qa to audit the whole set once the
       last panel is in. lib/server/run-qa.ts records why the per-panel judge
       had to go. */
    const runQaId = runTag;
    const runQaActive = isValidRunId(runQaId);
    const logId = crypto.randomUUID();
    if (runQaActive) {
      const productAnchorIdx = itemAnchorViews.map((v, i) => (v === "styling" ? -1 : i)).filter((i) => i >= 0);
      stashRunPanel(
        runQaId,
        {
          panel: Number(normalizedPanelQa.panelNumber) || 0,
          poseA: Number(normalizedPanelQa.poseA) || null,
          poseB: Number(normalizedPanelQa.poseB) || null,
          b64: await workingCopy(b64),
          logId,
        },
        {
          itemRefs: qaItemRefs.length ? qaItemRefs : productAnchorIdx.map((i) => itemAnchors[i]),
          itemRefViews: qaItemRefs.length
            ? qaItemViews
            : productAnchorIdx.map((i) => itemAnchorViews[i] as Exclude<ItemRefView, "styling">),
          modelRefs: modelRefDataUrls.length ? modelRefDataUrls : modelAnchors,
          itemSpec: itemSpecText,
          itemType: String(normalizedPanelQa.itemType || ""),
          colorName: colorRun?.name ?? "",
          instruction: operatorInstruction,
          modelGender: normalizedPanelQa.modelGender,
          accessoryKind: normalizedPanelQa.accessoryKind,
        },
      );
    }
    /* Keep this panel 1 as the stored look for (model, colour), so a later
       partial re-render can match it ("Keep look"). Best-effort, and after the
       followers were already released above. */
    const storedLook =
      source && isValidLookModelId(modelIdRaw)
        ? await storeLookAnchor({
            tenantId: session.tid,
            matrixId: matrixIdValid,
            modelId: modelIdRaw,
            colour: normalizeLookColour(itemColourRaw) || colorRun?.name || "",
            runTag: source.runId,
            b64,
            currentGate: () => readRunAnchorGate(source.runId)?.status ?? null,
          })
        : null;
    const droppedAny = Object.keys(imagesDropped).length > 0;
    return logged(
      { ...logRefs, id: logId, outcome: "ok", usage: imageUsage },
      NextResponse.json({
        imageBase64: b64,
        ...(runQaActive ? { runQaPending: true, runQaId } : {}),
        // Rides back with the image so a trimmed prompt is visible in the
        // Studio instead of only in a server log.
        ...(clamped.trimmed ? { promptTrimmed: true, promptOverflowBytes } : {}),
        backState,
        ...(anchorRole ? { anchor: { role: anchorRole, gate: anchorGate, waitMs: anchorWaitMs } } : {}),
        ...(storedLook ? { lookAnchor: { url: storedLook.url, key: storedLook.key, gate: storedLook.gate } } : {}),
        ...(droppedAny ? { imagesDropped } : {}),
      }),
    );
  } catch (err: unknown) {
    console.error("Generate failed:", err);
    const reason = err instanceof Error ? err.message : "Generate failed";
    anchorSourceFailure = describeSourceFailure(anchorSource?.panel ?? 1, "failed", "exception");
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
  } finally {
    /* A source that ended any way but a render — refused, failed, aborted,
       threw — still answers its followers, so none of them waits out the
       whole window for a panel 1 that is never coming. */
    if (anchorSource && !anchorSourceSettled) {
      settleRunAnchor(anchorSource.runId, {
        status: "failed",
        panel: anchorSource.panel,
        reason: anchorSourceFailure || `Panel ${anchorSource.panel} could not start`,
      });
    }
  }
}

export const POST = withActivity("generate", POST_handler);
