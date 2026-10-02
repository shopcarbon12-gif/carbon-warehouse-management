/* eslint-disable @typescript-eslint/no-explicit-any */
import OpenAI, { toFile } from "openai";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { LOCK_TEXT_MAX_BYTES, parseSpecBackState, specListsBackDesign, withCanonicalBackLine } from "@/lib/studio-item-spec";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import {
  recordStudioGeneration,
  type StudioGenerationLog,
} from "@/lib/server/studio-generation-log";
import { isValidRunId, stashRunPanel } from "@/lib/server/run-qa-store";
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
    const sideWordSource = `${itemSpecText}\n${typeof prompt === "string" ? prompt : ""}`;
    const sidePlacementLines = /\b(inner|inside|medial|inseam|outer|lateral|concealed|hidden|invisible)\b/i.test(
      sideWordSource,
    )
      ? [
          "- SIDE WORDS ARE GEOMETRY, NOT VISIBILITY. INNER / INSIDE / MEDIAL / INSEAM means the side of that limb which FACES THE OTHER LIMB, on the OUTER SURFACE of the fabric, fully visible in the picture. With both legs in frame, two inner details are the pair CLOSEST TOGETHER — one each side of the gap between the legs, mirroring each other across it. The far edge of each leg, the edge nearest the edge of the picture, carries NOTHING. Check it before you finish: if the two details sit far apart, one near each outside edge of the frame, they are on the wrong sides and must be mirrored inward. OUTER / LATERAL means that far edge, and a line saying INNER never puts anything there.",
          "- CONCEALED / HIDDEN / INVISIBLE describes a FINISH, never a reason to leave something out or move it. A concealed zip is present and visible as a slim closed seam with its small pull, simply with no exposed teeth. Draw it where its line says, at the size its line says.",
          "- Where this garment places a detail differently from how such garments are usually made, THIS garment wins. An ankle zip on the outer leg, a crease down the front, a pocket where there is none: the convention is not evidence, and copying it is an invention.",
        ]
      : [];

    const buildServerLockBlock = (modelCount: number, itemViewMapLines: string[]) => [
      buildServerLockPrompt(normalizedPanelQa, modelCount),
      ...itemViewMapLines,
      ...(itemSpecText
        ? [
            "VERIFIED ITEM SPEC (read off the item photos — every line MUST appear exactly as stated, in every frame and every panel. It overrides generic styling, but NOT the ITEM INSTRUCTION above: that was written by the person holding the garment, so where the two disagree about a placement, finish or fit, the instruction wins and this line yields):",
            clarifySideWords(itemSpecText),
            "- Every TEXT line is rendered letter-perfect (words, spelling, case, letterforms, colour, size) at its listed placement and side only — never a back print on the front or vice versa, never merged or swapped words, never extra text. Print effects (blurred / ghosted / faded / gradient / halftone / cracked) are part of the design and are rendered as such, never as a crisp clean version. The FIT/SILHOUETTE line is absolute: oversized reads clearly oversized, slim stays slim. HARDWARE / STITCHING / POCKET / MATERIAL lines match in kind, count, colour, finish and position. Anything NOT CLEARLY VISIBLE stays plain — never invented.",
            "- Small chest / sleeve / neck text keeps its true garment size but is still spelled letter-perfect in crisp, clean letterforms, even in full-body frames — never pseudo-letters, scribbles or a smudge.",
            "- A ZONE line is a complete account of that part of the garment: build it exactly as written and add nothing else there. Where a ZONE line says a zone is flat, plain or has none, that zone STAYS empty — no crease, no pleat, no pocket, no stripe, no topstitch that the line does not name.",
            ...buildBackStateLine(backState, normalizedPanelQa),
          ]
        : buildBackStateLine(backState, normalizedPanelQa)),
      buildBrandSafetyLock(normalizedPanelQa.itemType),
      ...sidePlacementLines,
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

    /* Run-level QA. The judge used to run once per panel, and a panel seen on
       its own cannot answer the question the operator actually has: are these
       eight pictures the same outfit on the same person? Each panel is stashed
       here as it lands, with the references already resolved for this request,
       and the Studio asks /api/generate/run-qa to audit the whole set once the
       last panel is in. lib/server/run-qa.ts records why the per-panel judge
       had to go. */
    const runQaId = req.headers.get("x-generate-run")?.trim() ?? "";
    const runQaActive = isValidRunId(runQaId);
    const logId = crypto.randomUUID();
    if (runQaActive) {
      stashRunPanel(
        runQaId,
        {
          panel: Number(normalizedPanelQa.panelNumber) || 0,
          poseA: Number(normalizedPanelQa.poseA) || null,
          poseB: Number(normalizedPanelQa.poseB) || null,
          b64,
          logId,
        },
        {
          itemRefs: itemRefDataUrls.length ? itemRefDataUrls : itemAnchors,
          itemRefViews: itemRefDataUrls.length ? itemRefViewsForQa : itemAnchorViews,
          modelRefs: modelRefDataUrls.length ? modelRefDataUrls : modelAnchors,
          itemSpec: itemSpecText,
          itemType: String(normalizedPanelQa.itemType || ""),
        },
      );
    }
    return logged(
      { ...logRefs, id: logId, outcome: "ok" },
      NextResponse.json({
        imageBase64: b64,
        ...(runQaActive ? { runQaPending: true, runQaId } : {}),
        // Rides back with the image so a trimmed prompt is visible in the
        // Studio instead of only in a server log.
        ...(clamped.trimmed ? { promptTrimmed: true, promptOverflowBytes } : {}),
        backState,
      }),
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
