/* eslint-disable @next/next/no-img-element */
"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ItemRefCropDialog } from "@/components/inventory/catalog/item-ref-crop-dialog";
import { parseSpecBackState, specListsBackDesign, specRiskReport, studioRefViewKey, type SpecIssue } from "@/lib/studio-item-spec";
import {
  accessoryPanelLabel,
  accessoryShotPair,
  accessoryTypeWord,
  buildAccessoryPanelPrompt,
  getAccessoryKind,
} from "@/lib/accessoryShots";
import {
  needsBackWaistbandTuck,
  specHasBackWaistbandLabel,
  parseOutfitFromSpec,
  type OutfitSlot,
  buildMasterPanelPrompt,
  getPanelPosePair,
  getPanelButtonLabel,
  pickExpressionDirective,
  splitPanelToThreeByFour,
} from "@/lib/panelGeneration";
import { instructionHasStyling, lookConflicts, resolveLookSheet, withNoteFootwear, type ResolvedStyling } from "@/lib/studioLookSheet";
import { stableLsSystemIdFromString } from "@/lib/utils/ls-id";
import { imageFilesFromTransfer } from "@/lib/client/image-transfer";
import type { BatchItemSummary, BatchOverview } from "@/lib/server/studio-batch";

/**
 * Carbon Studio (M2) — the OpenAI V2 generator, product-scoped.
 * Upload the item photo here (drag/file or phone-camera via QR), pick a model +
 * colour, choose one or MORE panels, generate, then push the chosen on-model
 * crops to Shopify per colour through the M2 image pipeline.
 */
type Model = { model_id: string; name: string; gender: string; ref_image_urls: string[] };
type StudioVariant = { id: string; color: string | null; shopify_variant_id?: string | null };
/** qaWarnings = what the run-level QA found wrong with THIS crop: either it
 * disagrees with the rest of the run (different shoes, different top, a
 * different face) or the garment does not match the reference photographs. The
 * crop is still delivered — flagged and unselected — so the operator sees the
 * render AND the reasons and decides. */
type Crop = {
  id: string;
  b64: string;
  label: string;
  selected: boolean;
  qaWarnings?: string[];
  qaNotes?: string[];
  /** Which half this crop is, so a verdict that arrives later lands on the right frame. */
  side?: "left" | "right";
  /** Which panel it came from, so a run-level finding lands on the right crop. */
  panel?: number;
  /** The run judges are still working (the image is already here). */
  qaPending?: boolean;
};
/** One colourway on file for this product: the single photo of it, the colour
 *  name the render must hit, anything the colour check found that disagrees
 *  with the product spec, and the seed that keeps this colour's poses and
 *  expressions away from the other colours'. */
type ColorRun = {
  color: string;
  colorRefUrl: string;
  colorName: string;
  hardwareNote: string;
  variationSeed: number;
};

/** url = what the generator fetches (may be an auth'd R2 URL); preview = a
 * browser-renderable thumbnail (data URL for uploads, public URL for Shopify). */
/** Item-reference sections (owner, 2026-08-26): General = exactly the old
 *  single box (accessories, flats, any view); Front / Back = the front / back
 *  of the garment, so analysis + generation + QA know which photo is which side
 *  and can never copy a back print onto the front. */
/* "Style with" (owner, 2026-10-11): OTHER products the model wears WITH this
   one — denim shorts styled with a shirt (front and back), shoes and a
   bracelet. They dress the model; they are never analyzed, QA'd or locked as
   the item, so adding one does not stale the spec. */
type RefView = "general" | "front" | "back" | "styling";
type ItemRef = { url: string; preview?: string; view?: RefView };
type RefViewLists = { general: string[]; front: string[]; back: string[]; styling: string[] };
const REF_VIEWS: { view: RefView; title: string; hint: string }[] = [
  { view: "general", title: "General", hint: "Accessories, flats, any view — works exactly as before." },
  { view: "front", title: "Front", hint: "The FRONT of the item (jeans, shirts, dresses…)." },
  { view: "back", title: "Back", hint: "The BACK of the item." },
  {
    view: "styling",
    title: "Style with",
    hint: "Other pieces the model wears WITH this item — e.g. a shirt (front and back), shoes, a bracelet. They replace the default outfit for what they cover; they are not the item and are not analyzed. Up to 6 photos.",
  },
];
const isRefView = (v: unknown): v is RefView => v === "general" || v === "front" || v === "back" || v === "styling";
/** The server sends at most this many style-with photos (OpenAI's 16-image cap). */
const MAX_STYLING_REFS = 6;
function groupRefs(refs: ItemRef[]): RefViewLists {
  const out: RefViewLists = { general: [], front: [], back: [], styling: [] };
  for (const r of refs) out[r.view ?? "general"].push(r.url);
  /* A photo in Style with is a piece to WEAR. Also dropping it into General /
     Front / Back would make the analysis and the render treat it as part of the
     product — the opposite of what the operator meant. Style with wins. */
  const styling = new Set(out.styling);
  if (styling.size) {
    out.general = out.general.filter((u) => !styling.has(u));
    out.front = out.front.filter((u) => !styling.has(u));
    out.back = out.back.filter((u) => !styling.has(u));
  }
  return out;
}
/** The PRODUCT's photos, in server-side order general → front → back (the
 *  prompt's view map counts on it). Style-with photos are not the product. */
const orderedRefUrls = (v: RefViewLists) => [...v.general, ...v.front, ...v.back];
/** What item analysis sees: the product's sections only. */
const productViews = (v: RefViewLists) => ({ general: v.general, front: v.front, back: v.back });
/** A ref is identified by url AND view: the same photo may be labelled in more
 *  than one section, and removing it from Front must not remove it from General. */
const sameRef = (a: ItemRef, b: { url: string; view?: RefView }) =>
  a.url === b.url && (a.view ?? "general") === (b.view ?? "general");
/** Drag payload for moving a reference between sections (copy, never move). */
const REF_DRAG_TYPE = "application/x-carbon-item-ref";
/* Shared with the server (lib/studio-item-spec) so "have the photos changed?"
   cannot be answered differently in the two places that ask it. */
const refViewKey = (v: RefViewLists) =>
  studioRefViewKey([
    ...v.general.map((url) => ({ url, view: "general" as const })),
    ...v.front.map((url) => ({ url, view: "front" as const })),
    ...v.back.map((url) => ({ url, view: "back" as const })),
  ]);
/** Poses that photograph the BACK of the garment (mirrors the server's list). */
const isBackFacingPose = (gender: string, pose: number) =>
  (gender || "").toLowerCase() === "female" ? pose === 2 : pose === 4 || pose === 7;
/** A stored reference restored from the server has no data-URL preview; R2
 *  objects are not browser-loadable, so they display through the proxy. */
const previewFor = (url: string) =>
  /r2\.cloudflarestorage\.com/i.test(url) ? `/api/studio/ref-image?u=${encodeURIComponent(url)}` : url;
/** What /api/studio/state keeps per product between sessions. */
type StudioState = {
  itemRefs: { url: string; view: RefView }[];
  itemType: string;
  instruction: string;
  itemSpec: string;
  specRefsKey: string;
  specConfirmed: boolean;
  backIsPlain: boolean;
  /** Read-only here: written by /api/generate after a successful panel 1. */
  lookAnchors?: Record<string, LookAnchor>;
  /** The jeans label picked for this product (studio_jeans_labels id), or null. */
  jeansLabelId?: string | null;
};
/** A photo of a real back-waistband label in the Studio's jeans-label library. */
type JeansLabel = { id: string; name: string; url: string };
/** The jeans-label box shows only for these item types (owner, 2026-10-14). */
const JEANS_LABEL_TYPES = /\bjeans\b|\bdenim\s+shorts?\b/i;
/** A media-manager row: an existing Shopify image or a new crop to add.
 * `color` = the variant colour this image is the MAIN pic for (all sizes). */
type MediaItem = {
  key: string;
  kind: "existing" | "new";
  mediaId?: string;
  b64?: string;
  url: string; // display src (cdn url for existing, data-url for new)
  alt: string;
  color: string;
};

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.readAsDataURL(file);
  });
}

/** Formats a browser can preview AND the OpenAI image API accepts as-is. */
const SAFE_IMAGE_TYPES = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);

/**
 * Downscale + re-encode an image before upload. Two problems this solves:
 *  1. Pasted screenshots / raw phone photos are 15-20MB (over the server cap →
 *     413); a 2048px JPEG is well under it and plenty for a generation reference.
 *  2. Exotic formats (HEIC from iPhone, BMP, TIFF, AVIF) either don't preview in
 *     the browser or are rejected by OpenAI ("unsupported image mimetype"). We
 *     re-encode anything the browser CAN decode to JPEG; anything it CANNOT
 *     decode (e.g. HEIC on Chrome) is rejected up-front with a clear message
 *     instead of silently uploading a file that won't preview or generate.
 * Alpha is flattened onto white so PNGs don't go black.
 */
async function downscaleForUpload(
  file: File,
  maxDim = 2048,
  quality = 0.9,
): Promise<{ blob: Blob; dataUrl: string; name: string }> {
  const srcUrl = await readAsDataUrl(file);
  const type = (file.type || "").toLowerCase();
  const label = file.name || "image";
  let img: HTMLImageElement;
  try {
    img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("decode"));
      im.src = srcUrl;
    });
  } catch {
    throw new Error(
      `${label}: this image format${type ? ` (${type})` : ""} isn't supported — please use JPG or PNG.`,
    );
  }
  const longest = Math.max(img.naturalWidth, img.naturalHeight) || 1;
  const scale = Math.min(1, maxDim / longest);
  // Fast path: already a preview/OpenAI-safe type, small, and not oversized.
  if (SAFE_IMAGE_TYPES.has(type) && scale >= 1 && file.size <= 4 * 1024 * 1024) {
    return { blob: file, dataUrl: srcUrl, name: label };
  }
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(`${label}: could not process this image — please use JPG or PNG.`);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", quality));
  if (!blob || blob.size === 0) {
    throw new Error(`${label}: could not process this image — please use JPG or PNG.`);
  }
  const base = label.replace(/\.[^.]+$/, "");
  return { blob, dataUrl: canvas.toDataURL("image/jpeg", quality), name: `${base}.jpg` };
}

/** Catalog images whose file names say an earlier generator made them. Used as
 *  item references they hand the new shoot their mistakes (Creed Jeans: the
 *  August renders' misspelled tee and missing back patch). */
const AI_RENDER_NAME = /\/(?:studio-|download_|carbon-studio-|ChatGPTImage|ChatGPT_Image|preview_|panel)[^/]*$/i;
function looksLikeAiRender(url: string): boolean {
  return AI_RENDER_NAME.test(String(url || "").split("?")[0]);
}

/** Per-operator Studio preferences (this browser only). */
function readPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* private mode — the toggle still works for this visit */
  }
}

/** A stored "look" (an approved panel 1) — GET /api/studio/state lookAnchors. */
type LookAnchor = { url: string; runTag?: string; at?: string; modelId?: string; colour?: string; gate?: string | null };
/** Same key the server stores looks under: `${modelId}|${COLOUR UPPERCASE, spaces collapsed}`. */
function lookAnchorKeyFor(modelId: string, colour: string): string {
  return `${modelId}|${String(colour || "").replace(/\s+/g, " ").trim().slice(0, 80).toUpperCase()}`;
}

type Props = {
  matrixId: string;
  shopifyProductId: string | null;
  itemRefUrls: string[];
  defaultItemType: string;
  /** Merchandise category (e.g. "WOMEN" / "MEN") — used to filter models by gender. */
  category?: string;
  /** The product name ("Beaded Bracelet A"). For products filed under
   *  ACCESSORIES it is what says which accessory this is. */
  productName?: string;
  variants: StudioVariant[];
  canManage: boolean;
  /** Bulk Studio (Inventory › Bulk Studio): the same tab, trimmed to photos,
   *  label, spec and options, driven by the page's Analyze all / Send batch. */
  bulk?: BulkStudioHooks;
};

/** What one product in the Bulk Studio reports to the page on every change. */
export type BulkStudioStatus = {
  matrixId: string;
  modelName: string | null;
  photoCount: number;
  /** none = never analysed; stale = photos changed since; ready = spec covers these photos. */
  spec: "none" | "stale" | "ready";
  /** Something is running in this product (upload, analysis, adding to the batch). */
  busy: boolean;
  /** What stops Analyze (missing photos) — empty when it can run. */
  analyzeProblems: string[];
  /** What stops adding to the batch, the same gates as "Add to tonight's batch". */
  sendProblems: string[];
  /** This product's batch runs not yet back (queued / preparing / with OpenAI). */
  batchOpen: number;
  /** Runs back from OpenAI and waiting to be loaded. */
  batchReady: number;
  /** The latest run's status line, for the item header. */
  batchLine: string | null;
  clockText: string;
  error: string | null;
  message: string | null;
};
export type BulkStudioApi = {
  /** Analyze the photos if the spec does not cover them yet. True = a spec covers them. */
  analyze: () => Promise<boolean>;
  /** Queue all four panels for the batch, exactly like "Add to tonight's batch". True = queued. */
  queue: () => Promise<boolean>;
  refreshBatch: () => Promise<void>;
};
/** What was filled in on an empty Bulk Studio item before its barcode was
    scanned. Applied once, after the product's saved state has loaded. */
export type BulkStudioDraft = {
  /** An uploaded file, or a photo the phone camera already stored (url). */
  files: { file?: File; url?: string; view: "general" | "front" | "back" | "styling" }[];
  modelId?: string;
  itemType?: string;
  instruction?: string;
  backIsPlain?: boolean;
};

export type BulkStudioHooks = {
  register: (api: BulkStudioApi | null) => void;
  onStatus: (s: BulkStudioStatus) => void;
  draft?: BulkStudioDraft | null;
  /** These draft photos have been taken in — the page drops them (more may
      have arrived meanwhile; those stay for the next pass). */
  onDraftUsed?: (used: BulkStudioDraft["files"]) => void;
  /** Bulk Studio: photos dropped on this item go to the page, which splits them
      into products (a new hang tag starts a new item) before they land. */
  ingest?: (entries: { file?: File; url?: string }[]) => void;
  /** Freshly scanned into the page: open with empty photo boxes (its earlier
      photos are not brought back). An item that was already on the page always
      loads its saved photos — never wipe them on a reload. */
  freshScan?: boolean;
  /** This product's saved state is in (the page clears freshScan). */
  onStateLoaded?: () => void;
};

const PANELS = [1, 2, 3, 4];

/** The accessory types the Studio shoots, each mapped to its own shot list. */
const ACCESSORY_TYPE_OPTIONS = [
  "BRACELET",
  "ANKLET",
  "NECKLACE",
  "RING",
  "EARRINGS",
  "WATCH",
  "SUNGLASSES",
  "HAT",
  "CAP",
  "BEANIE",
  "BELT",
  "BAG",
  "SOCKS",
  "BOW TIE",
];

/** Derive the item's gender from its category/type text. Women-first because
 * "WOMEN" contains "MEN". Returns null when it can't be determined (show all). */
function deriveGender(...text: (string | undefined)[]): "male" | "female" | null {
  const s = text.filter(Boolean).join(" ").toLowerCase();
  if (/(women|woman|female|ladies|lady|girl)/.test(s)) return "female";
  if (/\b(men|man|male|boy|mens|guys?)\b/.test(s) || /\bmen('s)?\b/.test(s)) return "male";
  return null;
}

/** Download an image (data-url or remote url) as a file. */
function downloadImage(src: string, name: string) {
  const a = document.createElement("a");
  a.href = src;
  a.download = name;
  a.target = "_blank";
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** What a panel generation answers with, from the direct POST or a job claim. */
type PanelResponse = {
  imageBase64?: string;
  degraded?: boolean;
  warning?: string;
  /** True when the server dropped part of the prompt to fit the length limit. */
  promptTrimmed?: boolean;
  promptOverflowBytes?: number;
  /** The server is holding this panel for the run-level judges, which run once
   *  every panel has landed. */
  runQaPending?: boolean;
  runQaId?: string;
  /** What the server established about the garment's back for this run. */
  backState?: "present" | "absent" | "unknown" | "photo";
  /** Cosmetic observations from QA (background, centring…) — never a failure. */
  qaNotes?: string[];
  /** Panel 1 of an anchored run was saved as this product's look for the model + colour. */
  lookAnchor?: { url?: string; key?: string; gate?: string | null };
  error?: unknown;
  status?: string;
};

/**
 * Background-safe generation.
 *
 * A panel takes OpenAI 60–90 s. The operator should be able to switch apps,
 * lock the phone or change browser tab in that window without losing the run:
 * every panel POST carries `x-generate-job`, so the server keeps rendering even
 * if this page is frozen/discarded and parks the result. When our connection
 * dies we claim that result instead of reporting a failed panel; if the page
 * itself was thrown away, the pending run in sessionStorage lets the Studio tab
 * pick the panels up when it comes back.
 */
const STUDIO_RUN_KEY = "wms_studio_pending_run";
const JOB_POLL_INTERVAL_MS = 3_000;
/** Long enough for a full render started just before the connection dropped. */
const JOB_POLL_TIMEOUT_MS = 5 * 60_000;
/** Matches the server-side park window (lib/server/generate-jobs.ts). */
const JOB_MAX_AGE_MS = 15 * 60_000;
/** A panel that follows panel 1 waits for it, its check and then its own render
 *  (the server gives a follower ~460 s in all). */
const FOLLOWER_POLL_TIMEOUT_MS = 9 * 60_000;

type PendingRun = {
  matrixId: string;
  runTag: string;
  gender: string;
  /** Accessory runs number their frames as shots, not poses. */
  accessory?: boolean;
  /** Panels 2–4 wait for panel 1 on the server — they take longer to land. */
  anchored?: boolean;
  startedAt: number;
  jobs: { panel: number; jobId: string }[];
};

/** The error body of a held / refused panel (see app/api/generate/route.ts). */
type PanelErrorBody = { type?: string; code?: string; message?: string; sourcePanel?: number; findings?: { text?: string }[] };
function panelErrorOf(json: PanelResponse | null): PanelErrorBody | null {
  const e = json?.error;
  return e && typeof e === "object" ? (e as PanelErrorBody) : null;
}

function readPendingRun(matrixId: string): PendingRun | null {
  try {
    const raw = sessionStorage.getItem(STUDIO_RUN_KEY);
    if (!raw) return null;
    const run = JSON.parse(raw) as PendingRun;
    if (run?.matrixId !== matrixId || !Array.isArray(run.jobs) || !run.jobs.length) return null;
    if (Date.now() - run.startedAt > JOB_MAX_AGE_MS) {
      sessionStorage.removeItem(STUDIO_RUN_KEY);
      return null;
    }
    return run;
  } catch {
    return null;
  }
}

function writePendingRun(run: PendingRun | null): void {
  try {
    if (run) sessionStorage.setItem(STUDIO_RUN_KEY, JSON.stringify(run));
    else sessionStorage.removeItem(STUDIO_RUN_KEY);
  } catch {
    /* private mode / storage full — generation still works, just no resume */
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Tell the CarbonWMS-PC Android shell that a long render is in flight, so it keeps
 * the page running while the operator is in another app (Android otherwise freezes
 * a backgrounded process within seconds). No-op in every browser and in app builds
 * that predate the hook — `window.CarbonWMSPC` simply isn't there.
 */
function setNativeBusy(busy: boolean): void {
  try {
    (
      window as unknown as { CarbonWMSPC?: { setBusy?: (label: string, busy: boolean) => void } }
    ).CarbonWMSPC?.setBusy?.("Generating Carbon Studio images…", busy);
  } catch {
    /* bridge unavailable — generation is unaffected */
  }
}

function newJobId(runTag: string, panel: number): string {
  return `${runTag}-p${panel}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Poll until the detached render lands. null = gone (expired, or server restarted). */
async function claimPanelJob(jobId: string, deadline: number, signal?: AbortSignal): Promise<PanelResponse | null> {
  while (Date.now() < deadline) {
    await sleep(JOB_POLL_INTERVAL_MS);
    if (signal?.aborted) return null;
    try {
      const r = await fetch(`/api/generate/job?id=${encodeURIComponent(jobId)}`, { cache: "no-store" });
      // 404 = expired/already claimed; 401/403 = session went away while we were
      // backgrounded. Neither improves by asking again for five minutes.
      if (r.status === 404 || r.status === 401 || r.status === 403) return null;
      if (!r.ok) continue;
      const j = (await r.json()) as PanelResponse;
      if (j.status === "done") return j;
    } catch {
      /* offline / still frozen — keep trying until the deadline */
    }
  }
  return null;
}

/** Abort button: stop the server-side render (and its OpenAI request) for this panel. */
function cancelPanelJob(jobId: string): void {
  void fetch(`/api/generate/job?id=${encodeURIComponent(jobId)}`, { method: "POST", keepalive: true }).catch(() => {});
}

/** We already have the image; drop the server's parked copy. */
function releasePanelJob(jobId: string): void {
  void fetch(`/api/generate/job?id=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** Night-batch times are read in the warehouse's clock (Eastern). */
function formatBatchTime(iso: string | null): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function batchStatusText(b: BatchItemSummary): string {
  switch (b.status) {
    case "queued":
      return "waits for the 1 AM send";
    case "preparing":
      return "being sent to OpenAI…";
    case "submitted":
      return b.batchStatus === "completed"
        ? "finished — storing the images…"
        : `with OpenAI${b.submittedAt ? ` since ${formatBatchTime(b.submittedAt)}` : ""}`;
    case "ready":
      return `ready — ${b.ready.length} of ${b.panels.length} panel(s)`;
    case "loaded":
      return `loaded into the Studio (${b.ready.length} of ${b.panels.length} panel(s))`;
    case "dismissed":
      return `removed from Bulk Studio › Upload (${b.ready.length} of ${b.panels.length} panel(s))`;
    case "published":
      return `published to Shopify from Bulk Studio (${b.ready.length} of ${b.panels.length} panel(s))`;
    case "failed":
      return b.error || "failed";
    default:
      return b.status;
  }
}

function batchStatusTone(status: string): string {
  if (status === "ready") return "font-semibold text-[var(--wms-accent)]";
  if (status === "failed") return "text-[var(--wms-status-danger-fg)]";
  return "text-[var(--wms-muted)]";
}

/** One panel response → the two crops the gallery shows (shared by run + resume). */
async function panelResponseToCrops(
  json: PanelResponse | null,
  panel: number,
  poseA: number,
  poseB: number,
  runTag: string,
  unit: "Pose" | "Shot" = "Pose",
): Promise<Crop[]> {
  if (!json || json.degraded || !json.imageBase64) {
    const e = json?.error;
    const detail =
      (typeof e === "string" ? e : (e as { message?: string })?.message) ||
      json?.warning ||
      (json ? "failed" : "lost connection and the result was no longer available");
    return [{ id: `p${panel}-err-${runTag}`, b64: "", label: `Panel ${panel}: ${detail}`, selected: false }];
  }
  const { left, right } = await splitPanelToThreeByFour(json.imageBase64);
  const qaNotes = Array.isArray(json.qaNotes) && json.qaNotes.length ? json.qaNotes : undefined;
  /* The server had to drop the MIDDLE of this panel's instructions to fit
     OpenAI's prompt limit, and generated anyway. Rides in as a note so the
     render is explainable instead of mysteriously ignoring a rule — it used to
     appear only in a server log. */
  const trimNote =
    json.promptTrimmed === true
      ? `Prompt was over the length limit by ~${Number(json.promptOverflowBytes || 0)} bytes — part of the instructions was dropped for this panel. Item details may be missed.`
      : null;
  const extraNotes = [trimNote].filter(Boolean) as string[];
  const notes = extraNotes.length ? [...(qaNotes ?? []), ...extraNotes] : qaNotes;
  /* The image is here; the judges only run once the whole run has landed,
     because what they check is how the frames compare with each other. Crops
     show now with a "checking" badge and the flags arrive after the last
     panel. */
  const qaPending = json.runQaPending === true;
  return [
    { id: `p${panel}-l-${runTag}`, b64: left, label: `P${panel} · ${unit} ${poseA}`, selected: true, qaNotes: notes, side: "left", panel, qaPending },
    { id: `p${panel}-r-${runTag}`, b64: right, label: `P${panel} · ${unit} ${poseB}`, selected: true, qaNotes: notes, side: "right", panel, qaPending },
  ];
}

type RunQaFinding = { panel: number; frame: "left" | "right" | "both"; text: string };
type RunQaVerdict = { findings: RunQaFinding[]; advisories: RunQaFinding[]; notes: string[]; unavailable: boolean };

/**
 * Start the run-level judges and wait for their verdict.
 *
 * The panels are already on the server, so this sends an id and nothing else.
 * Both judges run in parallel there; one pass asks whether the frames agree
 * with each other, the other whether the garment matches the photographs.
 */
async function collectRunQa(
  runId: string,
  apply: (v: RunQaVerdict | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const started = await fetch("/api/generate/run-qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId }),
    });
    if (!started.ok) return apply(null);
  } catch {
    return apply(null);
  }
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) return apply(null);
    try {
      const r = await fetch(`/api/generate/run-qa?id=${encodeURIComponent(runId)}`, { cache: "no-store" });
      if (r.status === 404) return apply(null); // expired / server restarted — no verdict, not a pass
      if (r.ok) {
        const j = (await r.json().catch(() => ({}))) as { status?: string } & Record<string, unknown>;
        if (j.status === "done") {
          const rows = Array.isArray(j.findings) ? (j.findings as unknown[]) : [];
          const adv = Array.isArray(j.advisories) ? (j.advisories as unknown[]) : [];
          const toFinding = (row: unknown): RunQaFinding | null => {
            const r = row as Record<string, unknown>;
            if (!r || typeof r !== "object") return null;
            const f: RunQaFinding = {
              panel: Number(r.panel) || 0,
              frame: r.frame === "left" ? "left" : r.frame === "right" ? "right" : "both",
              text: String(r.text ?? "").trim(),
            };
            return f.text && f.panel > 0 ? f : null;
          };
          return apply({
            advisories: adv.map(toFinding).filter((f): f is RunQaFinding => f !== null),
            findings: rows
              .map((row) => row as Record<string, unknown>)
              .filter((row) => row && typeof row === "object")
              .map((row): RunQaFinding => ({
                panel: Number(row.panel) || 0,
                frame: row.frame === "left" ? "left" : row.frame === "right" ? "right" : "both",
                text: String(row.text ?? "").trim(),
              }))
              .filter((f) => f.text && f.panel > 0),
            notes: Array.isArray(j.notes) ? (j.notes as string[]).map(String) : [],
            unavailable: j.unavailable === true,
          });
        }
      }
    } catch {
      /* transient — keep polling until the deadline */
    }
    await sleep(2000);
  }
  apply(null);
}

export function CarbonStudioTab({
  matrixId,
  shopifyProductId,
  itemRefUrls,
  defaultItemType,
  category,
  productName = "",
  variants,
  canManage,
  bulk,
}: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState<string>("");
  const bulkMode = Boolean(bulk);
  const freshScanRef = useRef(Boolean(bulk?.freshScan));
  const onStateLoadedRef = useRef<(() => void) | undefined>(undefined);
  onStateLoadedRef.current = bulk?.onStateLoaded;
  const bulkIngestRef = useRef<BulkStudioHooks["ingest"]>(undefined);
  bulkIngestRef.current = bulk?.ingest;
  /** Phone pose-plan banner's "Change model" jumps here. */
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  const [itemType, setItemType] = useState<string>(() =>
    /accessor/i.test(defaultItemType) ? accessoryTypeWord(productName) || defaultItemType : defaultItemType,
  );
  /* Accessory mode: the eight frames become a product shot list instead of
     garment poses (lib/accessoryShots.ts). Decided by the Item type field,
     and for products filed under ACCESSORIES by the product name. */
  const accessoryKind = useMemo(
    () => getAccessoryKind(itemType, productName, defaultItemType),
    [itemType, productName, defaultItemType],
  );
  const [instruction, setInstruction] = useState<string>("");
  const [panels, setPanels] = useState<number[]>([...PANELS]);
  /* Starts EMPTY. It used to start with the product's catalog images — which
     are the previous AI renders — so every regeneration was quietly shown its
     own last output as the garment reference, and drifted from it. Real
     photos are restored from /api/studio/state; catalog images are a button. */
  const [itemRefs, setItemRefs] = useState<ItemRef[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");
  /* Stopwatch for a run: starts on Generate, stops when the last panel lands,
     and the final time stays on screen. Regenerate starts it from zero. It is
     there to answer "how long did that actually take" without reading a log. */
  const [clock, setClock] = useState<{ startedAt: number; endedAt: number | null } | null>(null);
  const [clockNow, setClockNow] = useState<number>(0);
  useEffect(() => {
    if (!clock || clock.endedAt !== null) return;
    setClockNow(Date.now());
    const t = setInterval(() => setClockNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [clock]);
  const clockText = useMemo(() => {
    if (!clock) return "";
    const ms = Math.max(0, (clock.endedAt ?? clockNow) - clock.startedAt);
    const total = Math.floor(ms / 1000);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }, [clock, clockNow]);
  /* Abort button. Live while a run (analysis, panels or the checks after them)
     is in flight: aborting the fetches alone would not stop anything, because
     every panel renders DETACHED on the server — so each panel's job is
     cancelled there too, which aborts its OpenAI request. */
  const abortRef = useRef<{ controller: AbortController; jobIds: string[] } | null>(null);
  /** Style-with pieces already read, by photo set — so a re-run does not pay to read them again. */
  const stylePiecesRef = useRef(new Map<string, Partial<Record<OutfitSlot, string>>>());
  /** Styling words of the item instruction turned into pieces, by (instruction, type, gender, colour). */
  const lookResolveRef = useRef(new Map<string, ResolvedStyling | null>());
  /** The look/instruction conflict the operator has already been warned about (press again = go ahead). */
  const conflictAckRef = useRef("");
  /** The same two reads, as state, so the look preview refreshes once a run has made them. */
  const [readCache, setReadCache] = useState<{
    style: Record<string, Partial<Record<OutfitSlot, string>>>;
    styling: Record<string, ResolvedStyling | null>;
  }>({ style: {}, styling: {} });
  /* Panel 1 sets the look: panels 2–4 wait for it on the server and render
     with it attached, so the outfit, shoes and garment read as one shoot. */
  /* Off by default (owner, 2026-10-14: the wait doubled every run). */
  const [matchPanel1, setMatchPanel1] = useState(() => readPref("wms_studio_match_p1_v2", false));
  /* A re-render without panel 1 attaches this product's saved panel 1 for the
     same model and colour, so new crops match the ones already kept. */
  const [keepLook, setKeepLook] = useState(() => readPref("wms_studio_keep_look", true));
  /* Photographed styling pieces are worn print-free unless asked: a full-body
     frame cannot letter a tee's print and draws pseudo-letters instead. */
  /* On by default (owner rule: every piece uploaded is worn as photographed, prints included). */
  const [keepStylingPrints, setKeepStylingPrints] = useState(() => readPref("wms_studio_keep_prints_v2", true));
  const [lookAnchors, setLookAnchors] = useState<Record<string, LookAnchor>>({});
  /** Panel 1 was held by its accuracy check: the other panels wait for the operator. */
  const [heldRun, setHeldRun] = useState<{ runTag: string; sourcePanel: number; followers: number[]; findings: string[] } | null>(null);
  const forceFollowersRef = useRef<(() => Promise<void>) | null>(null);
  /* Jeans labels: photos of the real back-waistband patches, uploaded once and
     shared by every product; one is picked per product and attached to the
     panels with Pose 4 / Pose 7 so the patch is copied, not invented. */
  const [jeansLabels, setJeansLabels] = useState<JeansLabel[]>([]);
  const [jeansLabelId, setJeansLabelId] = useState<string | null>(null);
  const [labelBusy, setLabelBusy] = useState(false);
  const [aborting, setAborting] = useState(false);
  const abortGeneration = useCallback(() => {
    const live = abortRef.current;
    if (!live || live.controller.signal.aborted) return;
    setAborting(true);
    setProgress("Aborting…");
    live.controller.abort();
    for (const id of live.jobIds) cancelPanelJob(id);
  }, []);
  // Pre-generation item analysis: the item reference photos are inspected at
  // high detail — every word, graphic, material, button, stitch — and the
  // findings are locked into the prompt BEFORE rendering. The spec is shown
  // and editable, because a wrong line here is a wrong garment in four paid
  // panels. `specRefsKey` remembers which photos it was computed for.
  const [itemSpec, setItemSpec] = useState<string>("");
  const [specRefsKey, setSpecRefsKey] = useState<string>("");
  const [specConfirmed, setSpecConfirmed] = useState(false);
  const [specBusy, setSpecBusy] = useState(false);
  /* The operator looked at the real garment: the back carries nothing. Needed
     (or a Back photo) before any back-facing pose is rendered. */
  const [backIsPlain, setBackIsPlain] = useState(false);
  /* Persisted state has been read for this product — saves are gated on it so
     the empty initial render never overwrites what was stored. */
  const [stateLoaded, setStateLoaded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Photo problems only the operator can fix (a close-ups-only side) — amber,
   *  not red: nothing failed. */
  const [photoWarn, setPhotoWarn] = useState<string | null>(null);
  /** The analysis's second, independent read of each quoted text (spec risk check). */
  const [specTextReadings, setSpecTextReadings] = useState<{ quoted: string; reading: string | null }[]>([]);
  /** Reference photo being turned upright on the server (thumbnail ⟳). */
  const [rotatingUrl, setRotatingUrl] = useState<string | null>(null);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  /* The item reference behind the zoomed image, when there is one — so the
     full-size view can crop the photo you are actually looking at. Null when
     zooming a generated crop or a Shopify image, which are not references. */
  const [zoomRef, setZoomRef] = useState<ItemRef | null>(null);
  const [showMedia, setShowMedia] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [mediaBusy, setMediaBusy] = useState<string | null>(null);
  const [mediaDragKey, setMediaDragKey] = useState<string | null>(null);
  const [mediaSel, setMediaSel] = useState<Set<string>>(new Set());
  // Existing Shopify images are hidden by default; the operator opts in via the
  // "include current Shopify pictures" checkbox. We cache them so toggling is instant.
  const [includeShopify, setIncludeShopify] = useState(false);
  const [shopifyExisting, setShopifyExisting] = useState<MediaItem[]>([]);

  const toggleMediaSel = (key: string) =>
    setMediaSel((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const [qr, setQr] = useState<{ url: string; scanUrl: string; sessionId: string } | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  /** Which reference section is highlighted for drops; and which one pasted /
   *  phone-camera photos go to (the last section the operator touched). */
  /* Crop-in-place for an item reference. `src` must be something the browser
     can decode, so only refs that still carry their upload preview qualify —
     the stored R2 URL is private and would not load. */
  const [cropping, setCropping] = useState<{ ref: ItemRef; src: string } | null>(null);
  const [cropBusy, setCropBusy] = useState(false);
  const [cropErr, setCropErr] = useState<string | null>(null);
  const [dragOverView, setDragOverView] = useState<RefView | null>(null);
  const [activeView, setActiveView] = useState<RefView>("general");
  const activeViewRef = useRef<RefView>("general");
  const uploadViewRef = useRef<RefView>("general");
  const selectView = useCallback((v: RefView) => {
    activeViewRef.current = v;
    setActiveView(v);
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);

  /** A photo dropped on another section is ADDED there and stays where it was —
   *  one picture can legitimately be the general shot and the front shot at
   *  once. Shared by the desktop HTML5 drop and the touch drag below. */
  const copyRefToView = useCallback(
    (url: string, view: RefView) => {
      if (!canManage || !url) return;
      selectView(view);
      setItemRefs((prev) =>
        prev.some((x) => sameRef(x, { url, view }))
          ? prev // already labelled for this section — nothing to do
          : [...prev, { url, preview: prev.find((x) => x.url === url)?.preview, view }],
      );
    },
    [canManage, selectView],
  );

  /* Touch drag between the sections.
     HTML5 drag-and-drop does not exist on a touch screen, so on a phone the
     photos could not be moved between General / Front / Back at all. Pointer
     events cover touch and pen with one implementation; a mouse still takes
     the native HTML5 path, so desktop behaviour is untouched. A short
     press-and-hold starts the drag, which leaves a quick swipe free to scroll
     the page. */
  const [touchDrag, setTouchDrag] = useState<{ preview?: string; x: number; y: number } | null>(null);
  const touchDragRef = useRef<{
    url: string;
    preview?: string;
    from: RefView;
    pointerId: number;
    startX: number;
    startY: number;
    timer: ReturnType<typeof setTimeout> | null;
    active: boolean;
  } | null>(null);
  /** The zone under the finger, mirrored so a handler never reads a stale render. */
  const hoverViewRef = useRef<RefView | null>(null);
  /** A drag must not also fire the thumbnail's "open full size" click. */
  const suppressClickRef = useRef(0);
  const photosRef = useRef<HTMLDivElement | null>(null);

  const setHoverView = useCallback((v: RefView | null) => {
    hoverViewRef.current = v;
    setDragOverView(v);
  }, []);

  const endTouchDrag = useCallback(
    (drop: boolean) => {
      const d = touchDragRef.current;
      const over = hoverViewRef.current;
      touchDragRef.current = null;
      setTouchDrag(null);
      setHoverView(null);
      if (!d?.active) return;
      suppressClickRef.current = Date.now();
      if (drop && over && over !== d.from) copyRefToView(d.url, over);
    },
    [copyRefToView, setHoverView],
  );

  /* While a touch drag is live the page must not scroll under it. touch-action
     cannot be changed mid-gesture, so the move is cancelled here instead — a
     non-passive listener is the only thing a browser honours for this. */
  useEffect(() => {
    const el = photosRef.current;
    if (!el) return;
    const stop = (ev: TouchEvent) => {
      if (touchDragRef.current?.active) ev.preventDefault();
    };
    el.addEventListener("touchmove", stop, { passive: false });
    return () => el.removeEventListener("touchmove", stop);
  }, []);

  const colors = useMemo(() => {
    // All colours (independent of link status); prefer a linked variant when one
    // exists so the push has a target, but never hide colours from generation.
    const seen = new Map<string, StudioVariant>();
    for (const v of variants) {
      const key = (v.color || "").trim() || "—";
      const existing = seen.get(key);
      if (!existing || (!existing.shopify_variant_id && v.shopify_variant_id)) seen.set(key, v);
    }
    return Array.from(seen.entries()).map(([color, v]) => ({ color, variant: v }));
  }, [variants]);
  const [color, setColor] = useState<string>("");

  /* "Generate another colour": the same product rendered in a colourway we hold
     ONE photo of. The item analysis above is per product and is reused as-is —
     construction, text, placement and the zone map do not change with the dye,
     and a single phone photo could not overturn them. Only the cloth colour,
     that photo, and the variation seed are per colour. */
  const [colorRuns, setColorRuns] = useState<Record<string, ColorRun>>({});
  const [colorBusy, setColorBusy] = useState(false);
  const colorRun = colorRuns[color] ?? null;
  const loadColorRuns = useCallback(async () => {
    if (!matrixId) return;
    try {
      const r = await fetch(`/api/studio/color-run?matrixId=${encodeURIComponent(matrixId)}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json().catch(() => ({}))) as { runs?: ColorRun[] };
      const map: Record<string, ColorRun> = {};
      for (const run of j.runs ?? []) if (run?.color) map[run.color] = run;
      setColorRuns(map);
    } catch {
      /* the colourway panel simply shows nothing on file */
    }
  }, [matrixId]);
  useEffect(() => {
    void loadColorRuns();
  }, [loadColorRuns]);

  // Per-colour image assignment (matches Images tab): one colour → every size's
  // variant. Used to set a generated pic as the MAIN pic for a variant colour.
  const colorOpts = useMemo(() => {
    const byColor = new Map<string, string[]>();
    for (const v of variants) {
      const c = (v.color || "").trim();
      if (!c) continue;
      const arr = byColor.get(c) || [];
      if (v.shopify_variant_id) arr.push(v.shopify_variant_id);
      byColor.set(c, arr);
    }
    return Array.from(byColor.entries())
      .filter(([, ids]) => ids.length > 0)
      .map(([c, variantIds]) => ({ color: c, variantIds }));
  }, [variants]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch("/api/models/list");
        const j = (await r.json().catch(() => ({}))) as { models?: Model[] };
        if (!alive) return;
        const list = (j.models || []).filter((m) => (m.ref_image_urls || []).length >= 3);
        setModels(list);
        if (list[0]) setModelId(list[0].model_id);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!color && colors[0]) setColor(colors[0].color);
  }, [colors, color]);

  // Restore this product's photos, sorting, spec and back check.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch(`/api/studio/state?matrixId=${encodeURIComponent(matrixId)}`, { cache: "no-store" });
        const j = (await r.json().catch(() => ({}))) as { state?: StudioState | null; error?: string };
        if (!alive) return;
        if (!r.ok) {
          // Saving stays OFF: an empty page must never overwrite what is stored.
          setErr(`Could not load this product's saved Studio state (${j.error || `HTTP ${r.status}`}) — changes will not be saved until the page is reopened.`);
          return;
        }
        const s = j.state;
        if (s) {
          /* Bulk Studio (owner 2026-10-20): a scanned product opens with empty
             photo boxes — its earlier photos are not brought back. */
          const restored = bulkMode && freshScanRef.current ? [] : s.itemRefs.map((x): ItemRef => ({ url: x.url, view: x.view, preview: previewFor(x.url) }));
          // Merge, never replace: a photo pasted or uploaded before this
          // answer arrived must not vanish.
          /* Saved photos were prepared when they were added — never again. */
          for (const r0 of restored) prepSeen.current.add(r0.url);
          setItemRefs((prev) => [...restored, ...prev.filter((p) => !restored.some((r0) => sameRef(r0, p)))]);
          /* A product saved before accessory mode existed has "ACCESSORIES" on
             file, which says nothing about what to shoot; its own type word
             ("Anklet A" → ANKLET) is the better starting point. */
          if (s.itemType) {
            const generic = /^\s*accessor\w*\s*$/i.test(s.itemType);
            setItemType(generic ? accessoryTypeWord(productName) || s.itemType : s.itemType);
          }
          setInstruction(s.instruction || "");
          setItemSpec(s.itemSpec || "");
          setSpecRefsKey(s.specRefsKey || "");
          setSpecConfirmed(s.specConfirmed === true);
          setBackIsPlain(s.backIsPlain === true);
          setLookAnchors(s.lookAnchors && typeof s.lookAnchors === "object" ? s.lookAnchors : {});
          setJeansLabelId(typeof s.jeansLabelId === "string" && s.jeansLabelId ? s.jeansLabelId : null);
        }
        setStateLoaded(true);
        onStateLoadedRef.current?.();
      } catch {
        if (alive) setErr("Could not reach the server to load this product's saved Studio state — changes will not be saved until the page is reopened.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [matrixId, productName, bulkMode]);

  // Save it back, debounced, on every change after the restore. The pending
  // body lives in a ref so it can also be flushed on unmount / page hide —
  // otherwise the last tick or keystroke before closing the modal was lost.
  const pendingSaveRef = useRef<string | null>(null);
  const flushSave = useCallback(() => {
    const body = pendingSaveRef.current;
    if (!body) return;
    pendingSaveRef.current = null;
    void fetch("/api/studio/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!stateLoaded || !canManage) return;
    const body: StudioState & { matrixId: string } = {
      matrixId,
      itemRefs: itemRefs.map((r) => ({ url: r.url, view: r.view ?? "general" })),
      itemType,
      instruction,
      itemSpec,
      specRefsKey,
      specConfirmed,
      backIsPlain,
      jeansLabelId,
    };
    pendingSaveRef.current = JSON.stringify(body);
    const t = setTimeout(flushSave, 800);
    return () => clearTimeout(t);
  }, [stateLoaded, canManage, matrixId, itemRefs, itemType, instruction, itemSpec, specRefsKey, specConfirmed, backIsPlain, jeansLabelId, flushSave]);

  /* The label library is shared by every product — loaded once. */
  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    void fetch("/api/studio/labels", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { labels: [] }))
      .then((j: { labels?: JeansLabel[] }) => {
        if (alive && Array.isArray(j.labels)) setJeansLabels(j.labels);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [canManage]);
  const isJeansType = JEANS_LABEL_TYPES.test(itemType);
  const chosenLabel = useMemo(() => jeansLabels.find((l) => l.id === jeansLabelId) ?? null, [jeansLabels, jeansLabelId]);
  /** Upload label photos into the shared library (each stored like a model reference). */
  const uploadLabelPhotos = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setLabelBusy(true);
    setErr(null);
    const added: JeansLabel[] = [];
    try {
      for (const file of images) {
        const { blob, name } = await downscaleForUpload(file);
        const fd = new FormData();
        fd.append("file", blob, name);
        const up = await fetch("/api/models/upload", { method: "POST", body: fd });
        const uj = (await up.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!up.ok || !uj.url) throw new Error(uj.error ?? `Upload failed (HTTP ${up.status})`);
        const r = await fetch("/api/studio/labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: uj.url, name: file.name.replace(/\.[^.]+$/, "") }),
        });
        const j = (await r.json().catch(() => ({}))) as { label?: JeansLabel; error?: string };
        if (!r.ok || !j.label) throw new Error(j.error ?? `Could not save the label (HTTP ${r.status})`);
        added.push(j.label);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Label upload failed.");
    } finally {
      if (added.length) {
        setJeansLabels((prev) => [...added, ...prev]);
        setMsg(`Added ${added.length} label photo${added.length === 1 ? "" : "s"} to the library.`);
      }
      setLabelBusy(false);
    }
  }, []);
  /** Phone photos of labels → the shared library (one POST each, like an upload). */
  const adoptLabelPhotos = useCallback(async (urls: string[]) => {
    if (!urls.length) return;
    setLabelBusy(true);
    const added: JeansLabel[] = [];
    try {
      for (const [i, url] of urls.entries()) {
        const r = await fetch("/api/studio/labels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, name: `phone label ${new Date().toISOString().slice(5, 16).replace("T", " ")}${urls.length > 1 ? ` #${i + 1}` : ""}` }),
        });
        const j = (await r.json().catch(() => ({}))) as { label?: JeansLabel; error?: string };
        if (!r.ok || !j.label) throw new Error(j.error ?? `Could not save the label (HTTP ${r.status})`);
        added.push(j.label);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not save the phone label photos.");
    } finally {
      if (added.length) {
        setJeansLabels((prev) => [...added, ...prev.filter((p) => !added.some((a) => a.id === p.id))]);
        setMsg(`Added ${added.length} label photo${added.length === 1 ? "" : "s"} from the phone to the library.`);
      }
      setLabelBusy(false);
    }
  }, []);
  useEffect(() => {
    adoptLabelPhotosRef.current = adoptLabelPhotos;
  }, [adoptLabelPhotos]);
  const removeLabel = useCallback(
    async (label: JeansLabel) => {
      if (!window.confirm(`Remove "${label.name || "this label"}" from the label library? Products that use it will have no label picked.`)) return;
      setLabelBusy(true);
      try {
        const r = await fetch(`/api/studio/labels/${encodeURIComponent(label.id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`Could not remove the label (HTTP ${r.status})`);
        setJeansLabels((prev) => prev.filter((l) => l.id !== label.id));
        if (jeansLabelId === label.id) setJeansLabelId(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not remove the label.");
      } finally {
        setLabelBusy(false);
      }
    },
    [jeansLabelId],
  );
  useEffect(() => {
    window.addEventListener("pagehide", flushSave);
    return () => {
      window.removeEventListener("pagehide", flushSave);
      flushSave();
    };
  }, [flushSave]);

  const refViews = useMemo(() => groupRefs(itemRefs), [itemRefs]);
  /** Photos of the item itself — Style with photos are worn with it, not it. */
  const productRefCount = refViews.general.length + refViews.front.length + refViews.back.length;
  const refsKey = useMemo(() => refViewKey(refViews), [refViews]);
  /** No spec yet, or the photos changed since it was computed (an operator
   *  edit counts as covering the current photos — see the textarea). */
  const specStale = !itemSpec.trim() || specRefsKey !== refsKey;
  /** What the spec itself says about the back — the server applies the same
   *  rule, so the client gate and the render can never disagree. */
  const specBack = useMemo(() => parseSpecBackState(itemSpec), [itemSpec]);
  const specSaysBackDesign = useMemo(() => specBack === "design" || specListsBackDesign(itemSpec), [specBack, itemSpec]);
  /** The spec lines most likely to be wrong, re-read on every edit. A wrong line
   *  is a wrong garment in every paid panel, so `blocking` holds Generate until a
   *  person confirms the spec. */
  const specRisk = useMemo(
    () =>
      itemSpec.trim()
        ? specRiskReport(itemSpec, {
            productName,
            itemType,
            isAccessory: Boolean(accessoryKind),
            refCount: productRefCount,
            specConfirmed,
            textReadings: specTextReadings,
          })
        : { blocking: [] as SpecIssue[], warnings: [] as SpecIssue[] },
    [itemSpec, productName, itemType, accessoryKind, productRefCount, specConfirmed, specTextReadings],
  );
  const specBlocked = specRisk.blocking.length > 0 && !specConfirmed;
  /** Item references whose file names say an earlier generator made them. */
  const aiRefWarn = useMemo(() => {
    const n = itemRefs.filter((r) => r.view !== "styling" && looksLikeAiRender(r.url)).length;
    return n
      ? `${n} item photo${n === 1 ? " looks" : "s look"} like an earlier AI render (catalog file name). A render used as a reference carries its mistakes — misspelled prints, missing back details — into the new shoot. Use real photos of the garment.`
      : null;
  }, [itemRefs]);
  /** Catalog images not yet added as references. */
  const catalogPhotosLeft = useMemo(
    () => (itemRefUrls || []).filter((u) => !itemRefs.some((r) => r.url === u)),
    [itemRefUrls, itemRefs],
  );

  /* Mirror of itemRefs for code that must dedupe synchronously (the phone
     hand-off), without waiting for a render. */
  const itemRefsRef = useRef<ItemRef[]>([]);
  useEffect(() => {
    itemRefsRef.current = itemRefs;
  }, [itemRefs]);

  /* Every hand-off url this QR session has handed to the tray, whether it is
     still there or not: a re-collect ("Check again", the drain on Done) must
     not bring back a photo the operator removed or cropped away. */
  const handoffSeenRef = useRef<Set<string>>(new Set());
  /* Which slot the phone is currently feeding: the item-reference tray, or the
     colourway's single photo. A ref, not state, because addHandoffBatch holds
     no dependencies on purpose — a verdict that lands after the panel closed
     must still be delivered. */
  const handoffTargetRef = useRef<"refs" | "colour" | "label">("refs");
  /* Shown in the jeans-label box while its phone session is the one open. */
  const [labelPhoneOpen, setLabelPhoneOpen] = useState(false);
  /* Late-bound for the same reason: addHandoffBatch is created once, and must
     call the CURRENT adopt function rather than the one that existed then. */
  const adoptColorPhotoRef = useRef<(url: string) => void | Promise<void>>(() => {});
  /* Same late binding for the jeans-label library (phone photos of labels). */
  const adoptLabelPhotosRef = useRef<(urls: string[]) => void | Promise<void>>(() => {});
  /* When the server will drop the session — refreshed from every poll (each
     phone upload extends it), so the panel's lifetime follows the phone's
     activity instead of a fixed timer that ran out mid-upload. */
  const sessionExpiresRef = useRef<number>(0);

  /** Add photos the phone sent, deduped by url. Never gated on "is the poll
   *  still running": a response that lands after the QR panel closed is
   *  still a photo the operator took. (That gate, plus a 5-minute auto-close,
   *  is how 4 of 5 photos sent at 06:55 on 2026-09-29 were stranded.) */
  const addHandoffBatch = useCallback((images: { imageUrl: string }[]) => {
    const view = activeViewRef.current;
    const fresh = images.filter(
      (im) => im.imageUrl && !handoffSeenRef.current.has(im.imageUrl) && !itemRefsRef.current.some((p) => p.url === im.imageUrl),
    );
    if (!fresh.length) return 0;
    for (const im of fresh) handoffSeenRef.current.add(im.imageUrl);
    /* Opened from the jeans-label box: every photo of this session is a label
       for the shared library (several labels in one go), never a product photo. */
    if (handoffTargetRef.current === "label") {
      void adoptLabelPhotosRef.current(fresh.map((im) => im.imageUrl));
      return fresh.length;
    }
    /* The operator opened the QR from the colourway row, so the next photo is
       the colour sample, not another product reference. One photo is all that
       slot holds; the target resets immediately so a second shot behaves
       normally instead of silently replacing the first. */
    if (handoffTargetRef.current === "colour") {
      handoffTargetRef.current = "refs";
      void adoptColorPhotoRef.current(fresh[0].imageUrl);
      const rest = fresh.slice(1);
      if (!rest.length) return 1;
      const more = rest.map((im): ItemRef => ({ url: im.imageUrl, preview: previewFor(im.imageUrl), view }));
      itemRefsRef.current = [...itemRefsRef.current, ...more];
      setItemRefs((prev) => [...prev, ...more.filter((b) => !prev.some((p) => p.url === b.url))]);
      return fresh.length;
    }
    if (bulkIngestRef.current) {
      bulkIngestRef.current(fresh.map((im) => ({ url: im.imageUrl })));
      return fresh.length;
    }
    // Displayed through the durable admin proxy (the session-scoped preview
    // route dies with the session; the R2 object does not).
    const batch = fresh.map((im): ItemRef => ({ url: im.imageUrl, preview: previewFor(im.imageUrl), view }));
    itemRefsRef.current = [...itemRefsRef.current, ...batch];
    setItemRefs((prev) => [...prev, ...batch.filter((b) => !prev.some((p) => p.url === b.url))]);
    return fresh.length;
  }, []);

  /** Collect from the hand-off session: the photos since the last poll, or
   *  (`all`) everything it ever received. */
  const collectHandoff = useCallback(
    async (sessionId: string, all: boolean): Promise<{ status: "ok" | "gone" | "error"; added: number }> => {
      try {
        const r = await fetch(`/api/image-handoff/session/${encodeURIComponent(sessionId)}${all ? "?all=1" : ""}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (r.status === 404) return { status: "gone", added: 0 };
        if (!r.ok) return { status: "error", added: 0 };
        const j = (await r.json().catch(() => ({}))) as {
          ready?: boolean;
          images?: { imageUrl: string }[];
          expiresAt?: number;
        };
        if (Number(j.expiresAt) > 0) sessionExpiresRef.current = Number(j.expiresAt);
        let added = 0;
        if (j.ready && j.images?.length) {
          added = addHandoffBatch(j.images);
          if (added) setMsg(`Received ${added} photo${added === 1 ? "" : "s"} from phone.`);
        }
        return { status: "ok", added };
      } catch {
        return { status: "error", added: 0 };
      }
    },
    [addHandoffBatch],
  );

  /** "Done": collect everything the session received, THEN close — and only
   *  close if that worked, so a network blip cannot discard the session. */
  const finishPhoneCamera = useCallback(async () => {
    const s = qr;
    if (!s) return;
    setQrBusy(true);
    try {
      const res = await collectHandoff(s.sessionId, true);
      if (res.status === "error") {
        setErr("Could not collect the phone photos — check the connection and press Done again.");
        return;
      }
      setQr(null);
      // The next phone session feeds the item photos again.
      handoffTargetRef.current = "refs";
      setLabelPhoneOpen(false);
    } finally {
      setQrBusy(false);
    }
  }, [qr, collectHandoff]);

  // Poll the phone-camera hand-off while the QR panel is open, for as long
  // as the server keeps the session. When the session lapses (the phone has
  // been quiet for 15 min) the panel drains and closes with a message —
  // never silently, and never before a final collect.
  useEffect(() => {
    if (!qr) return;
    let inFlight = false;
    let errors = 0;
    const timer = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        if (sessionExpiresRef.current && Date.now() > sessionExpiresRef.current + 30_000) {
          await collectHandoff(qr.sessionId, true);
          setMsg("The phone session ended (no photos for 15 minutes) — everything it received is in the tray.");
          setQr(null);
          return;
        }
        const res = await collectHandoff(qr.sessionId, false);
        if (res.status === "gone") {
          setErr("The phone session expired — click 📱 Phone camera and scan the new code.");
          setQr(null);
          return;
        }
        errors = res.status === "error" ? errors + 1 : 0;
        if (errors === 5) setErr("Cannot reach the server to collect phone photos — the panel stays open; photos are kept on the server.");
      } finally {
        inFlight = false;
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [qr, collectHandoff]);

  /* Photos a phone sent for THIS product that no desktop ever collected (a
     panel closed early, a discarded tab, a deploy in between). Counted on
     open; added on request. */
  const [recoverCount, setRecoverCount] = useState(0);
  const [recoverBusy, setRecoverBusy] = useState(false);
  useEffect(() => {
    if (!stateLoaded) return;
    let alive = true;
    void fetch(`/api/studio/handoff-recover?matrixId=${encodeURIComponent(matrixId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { count?: number } | null) => {
        if (alive && j && Number(j.count) > 0) setRecoverCount(Number(j.count));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [stateLoaded, matrixId]);
  const recoverHandoff = useCallback(async () => {
    setRecoverBusy(true);
    try {
      const r = await fetch(`/api/studio/handoff-recover?matrixId=${encodeURIComponent(matrixId)}&take=1`, { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as { images?: { imageUrl: string }[]; error?: string };
      if (!r.ok) throw new Error(j.error || "Could not recover the phone photos.");
      const n = addHandoffBatch(j.images ?? []);
      setMsg(n ? `Added ${n} photo${n === 1 ? "" : "s"} from the earlier phone session.` : "Nothing new to add.");
      setRecoverCount(0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not recover the phone photos.");
    } finally {
      setRecoverBusy(false);
    }
  }, [matrixId, addHandoffBatch]);

  // Show only models whose gender matches the item (men→male, women→female).
  // Falls back to all models when the item's gender can't be determined.
  const itemGender = useMemo(
    () => deriveGender(category, defaultItemType, itemType),
    [category, defaultItemType, itemType],
  );
  const visibleModels = useMemo(
    () => (itemGender ? models.filter((m) => (m.gender || "").toLowerCase() === itemGender) : models),
    [models, itemGender],
  );
  useEffect(() => {
    if (visibleModels.length && !visibleModels.some((m) => m.model_id === modelId)) {
      setModelId(visibleModels[0].model_id);
    }
  }, [visibleModels, modelId]);

  const model = models.find((m) => m.model_id === modelId) || null;
  /** The look this run will use, as far as it is known before Generate (Style
   *  with and instruction styling are read at Generate if not read yet). */
  const lookPreview = useMemo(() => {
    if (!model) return null;
    const garmentColour = /^\s*\d+\.\s*Garment:[^—\n]*—\s*([^\n.]+)/m.exec(itemSpec)?.[1] ?? "";
    const itemColour = (colorRun?.colorRefUrl ? colorRun.colorName : "") || garmentColour || color;
    const styleKey = refViews.styling.join("|") + "::" + itemType;
    const instr = instruction.trim();
    const resolveKey = [instr, itemType, model.gender, itemColour].join("::");
    const pendingReads = [
      refViews.styling.length && !(styleKey in readCache.style) ? "the Style with photos" : "",
      instr && instructionHasStyling(instr) && !(resolveKey in readCache.styling) ? "the styling in the item instruction" : "",
    ].filter(Boolean);
    const sheet = resolveLookSheet({
      itemType,
      gender: model.gender === "female" ? "female" : "male",
      productName,
      specOutfit: parseOutfitFromSpec(itemSpec),
      styleWith: readCache.style[styleKey] ?? {},
      instructionStyling: withNoteFootwear(readCache.styling[resolveKey] ?? null, instr),
      itemColour,
      accessoryKind,
      seedKey: `${matrixId}|${model.model_id}|${color || itemColour}`,
      keepStylingPrints,
      backWaistbandLabel: !accessoryKind && needsBackWaistbandTuck(itemType, itemSpec),
    });
    /* Shown only once the instruction has been read: before that the reader may still supply the piece. */
    const conflicts = pendingReads.length ? [] : lookConflicts(instr, sheet);
    return { text: sheet.text, pendingReads, conflicts };
  }, [model, itemSpec, colorRun, color, refViews.styling, itemType, instruction, productName, accessoryKind, matrixId, keepStylingPrints, readCache]);

  const prepRefsRef = useRef<(refs: ItemRef[]) => void>(() => {});
  const uploadItems = useCallback(async (files: File[], view?: RefView) => {
    const list = files.filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
    const targetView: RefView = view ?? activeViewRef.current;
    setBusy("upload");
    setErr(null);
    try {
      const results = await Promise.allSettled(
        list.map(async (file) => {
          const { blob, dataUrl, name } = await downscaleForUpload(file);
          const fd = new FormData();
          fd.append("file", blob, name);
          const r = await fetch("/api/models/upload", { method: "POST", body: fd });
          const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
          if (!r.ok || !j.url) throw new Error(j.error ?? `Upload failed (HTTP ${r.status})`);
          return { url: j.url as string, preview: dataUrl, view: targetView } as ItemRef;
        }),
      );
      const ok = results
        .filter((x): x is PromiseFulfilledResult<ItemRef> => x.status === "fulfilled")
        .map((x) => x.value);
      if (ok.length) setItemRefs((prev) => [...prev, ...ok]);
      prepRefsRef.current(ok);
      const failed = results.length - ok.length;
      if (failed) {
        const firstErr = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        const reason = firstErr?.reason instanceof Error ? firstErr.reason.message : String(firstErr?.reason ?? "");
        setErr(`${failed} of ${results.length} photo upload(s) failed${reason ? `: ${reason}` : "."}`);
      }
    } finally {
      setBusy(null);
    }
  }, []);

  /* Bulk Studio (owner 2026-10-20): every photo added to General / Front / Back
     — uploaded, from the phone, or handed over from before the scan — is
     prepared on its own: moved to the box it belongs in, turned upright, and
     a person's head cut off just under the chin. It shows at once where it was
     dropped and moves when it is ready; the manual rotate / crop / drag still
     work afterwards. Style with photos are other products and are left alone. */
  const prepSeen = useRef<Set<string>>(new Set());
  const [prepping, setPrepping] = useState(0);
  /* Called only where photos are ADDED (upload, phone, the pre-scan draft) —
     never for a copy made by rotate / crop / drag, so a manual fix is never
     re-sorted or turned back (owner 2026-10-20). One call per photo address. */
  const prepItemRefs = useCallback(
    (refs: ItemRef[]) => {
      if (!bulkMode) return;
      const fresh = refs.filter((r) => (r.view ?? "general") !== "styling" && !prepSeen.current.has(r.url));
      const urls = [...new Set(fresh.map((r) => r.url))];
      for (const u of urls) prepSeen.current.add(u);
      for (const srcUrl of urls) {
        setPrepping((n) => n + 1);
        void fetch("/api/studio/auto-prep", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: srcUrl, item: [productName, itemType].filter(Boolean).join(" — ") }),
        })
          .then(async (res) => {
            const j = (await res.json().catch(() => ({}))) as { url?: string; view?: RefView };
            if (!res.ok || !j.url) return;
            const nextUrl = j.url;
            const nextView: RefView = j.view === "front" || j.view === "back" || j.view === "styling" ? j.view : "general";
            prepSeen.current.add(nextUrl);
            setItemRefs((prev) => {
              const at = prev.findIndex((p0) => p0.url === srcUrl);
              if (at < 0) return prev; // removed meanwhile
              const changed = nextUrl !== srcUrl;
              const ref: ItemRef = { url: nextUrl, view: nextView, preview: changed ? previewFor(nextUrl) : prev[at].preview };
              const rest = prev.filter((p0, i) => i !== at && p0.url !== srcUrl && !(p0.url === nextUrl && p0.view === nextView));
              return [...rest.slice(0, at), ref, ...rest.slice(at)];
            });
          })
          .catch(() => {})
          .finally(() => setPrepping((n) => n - 1));
      }
    },
    [bulkMode, productName, itemType],
  );
  prepRefsRef.current = prepItemRefs;

  /* Bulk Studio: apply what was filled in before the barcode was scanned —
     once, after this product's saved state is in (so nothing saved is lost). */
  /* Each draft photo is taken in exactly once (photos keep arriving while
     earlier ones upload); the fields are applied the first time only. */
  const draftTaken = useRef(new Set<object>());
  const draftFieldsDone = useRef(false);
  const bulkDraft = bulk?.draft;
  const bulkDraftUsed = bulk?.onDraftUsed;
  useEffect(() => {
    if (!stateLoaded || !bulkDraft) return;
    if (bulkDraft.modelId && !models.length) return; // wait for the model list
    if (!draftFieldsDone.current) {
      draftFieldsDone.current = true;
      if (bulkDraft.modelId && models.some((m0) => m0.model_id === bulkDraft.modelId)) setModelId(bulkDraft.modelId);
      if (bulkDraft.itemType?.trim()) setItemType(bulkDraft.itemType.trim());
      if (bulkDraft.instruction?.trim()) setInstruction(bulkDraft.instruction.trim());
      if (bulkDraft.backIsPlain) setBackIsPlain(true);
    }
    const fresh = bulkDraft.files.filter((f) => !draftTaken.current.has(f));
    if (!fresh.length) return;
    fresh.forEach((f) => draftTaken.current.add(f));
    const stored = fresh
      .filter((f) => f.url)
      .map((f): ItemRef => ({ url: f.url as string, view: f.view, preview: previewFor(f.url as string) }));
    if (stored.length) {
      setItemRefs((prev) => [...prev, ...stored.filter((b) => !prev.some((p0) => p0.url === b.url))]);
      prepRefsRef.current(stored);
    }
    void (async () => {
      for (const view of ["general", "front", "back", "styling"] as const) {
        const files = fresh.filter((f) => f.view === view && f.file).map((f) => f.file as File);
        if (files.length) await uploadItems(files, view);
      }
      bulkDraftUsed?.(fresh);
    })();
  }, [stateLoaded, bulkDraft, bulkDraftUsed, models, uploadItems]);

  /**
   * Take a stored photo as THIS colour's sample: read the colour off it, note
   * anything that disagrees with the product spec, and save both.
   *
   * The colour is named rather than left as "whatever that photo looks like",
   * because a phone photo carries its lighting with it — warm indoors, blue in
   * shade — and the name is what the operator can correct when it reads wrong.
   */
  const adoptColorPhoto = useCallback(
    async (url: string) => {
      const target = color;
      if (!target || !url) return;
      setColorBusy(true);
      setErr(null);
      try {
        let colorName = "";
        let hardwareNote = "";
        try {
          const r = await fetch("/api/openai/color-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ colorRef: url, itemSpec, itemType, colorLabel: target }),
          });
          const j = (await r.json().catch(() => ({}))) as {
            colorName?: string;
            colorDetail?: string;
            uncertain?: string;
            hardwareNote?: string;
            error?: string;
          };
          if (!r.ok) throw new Error(j.error || `Colour check failed (HTTP ${r.status})`);
          colorName = [j.colorName, j.colorDetail].filter(Boolean).join(" — ").slice(0, 120);
          hardwareNote = [j.hardwareNote, j.uncertain ? `Uncertain: ${j.uncertain}` : ""].filter(Boolean).join(" ");
        } catch (e) {
          /* The photo is still the colour reference even when the check fails;
             it goes to the generator either way. Only the name is missing, and
             the operator can type it. */
          setErr(
            `Colour photo saved, but the colour could not be read automatically${
              e instanceof Error ? `: ${e.message}` : "."
            } Type the colour name yourself before generating.`,
          );
        }
        const save = await fetch("/api/studio/color-run", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ matrixId, color: target, colorRefUrl: url, colorName, hardwareNote }),
        });
        const sj = (await save.json().catch(() => ({}))) as { run?: ColorRun; error?: string };
        if (!save.ok || !sj.run) throw new Error(sj.error || `Could not save the colourway (HTTP ${save.status})`);
        setColorRuns((prev) => ({ ...prev, [target]: sj.run as ColorRun }));
        if (colorName) setMsg(`Colour read as "${colorName}".`);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not save the colourway photo.");
      } finally {
        setColorBusy(false);
      }
    },
    [color, itemSpec, itemType, matrixId],
  );
  useEffect(() => {
    adoptColorPhotoRef.current = adoptColorPhoto;
  }, [adoptColorPhoto]);

  /** Upload one file as this colour's sample. */
  const uploadColorPhoto = useCallback(
    async (file: File | undefined) => {
      if (!file || !file.type.startsWith("image/")) return;
      setColorBusy(true);
      setErr(null);
      try {
        const { blob, name } = await downscaleForUpload(file);
        const fd = new FormData();
        fd.append("file", blob, name);
        const r = await fetch("/api/models/upload", { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!r.ok || !j.url) throw new Error(j.error ?? `Upload failed (HTTP ${r.status})`);
        await adoptColorPhoto(j.url);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Colour photo upload failed.");
        setColorBusy(false);
      }
    },
    [adoptColorPhoto],
  );

  /** Forget this colourway: the product's own photos and spec are untouched. */
  const clearColorRun = useCallback(async () => {
    if (!color || !matrixId) return;
    setColorBusy(true);
    try {
      await fetch(
        `/api/studio/color-run?matrixId=${encodeURIComponent(matrixId)}&color=${encodeURIComponent(color)}`,
        { method: "DELETE" },
      );
      setColorRuns((prev) => {
        const next = { ...prev };
        delete next[color];
        return next;
      });
    } finally {
      setColorBusy(false);
    }
  }, [color, matrixId]);

  /** Replace one item reference with its cropped version, keeping its view. */
  const applyCrop = useCallback(
    async (blob: Blob) => {
      const target = cropping?.ref;
      if (!target) {
        // The last silent path: this returned with no error and no log, which
        // is indistinguishable from a dead button.
        console.error("[studio] crop: no target reference in state");
        setCropErr("Lost track of which photo was being cropped — close this and try again.");
        return;
      }
      setCropBusy(true);
      setCropErr(null);
      try {
        /* Upload the cropped bytes AS THEY ARE. Running them back through
           downscaleForUpload re-encoded the crop a second time — and for
           anything over 4MB also rescaled it — so a crop of an already-
           compressed preview came out visibly worse than the photo it came
           from. The crop is never larger than its source, which the upload
           path had already bounded, so there is nothing left to downscale. */
        const ext = blob.type === "image/png" ? "png" : "jpg";
        const name = `cropped.${ext}`;
        const file = new File([blob], name, { type: blob.type || "image/png" });
        const dataUrl = await readAsDataUrl(file);
        const fd = new FormData();
        fd.append("file", file, name);
        const r = await fetch("/api/models/upload", { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!r.ok || !j.url) throw new Error(j.error ?? `Upload failed (HTTP ${r.status})`);
        /* Replace EVERY copy of this photo: the same picture may be labelled
           in more than one section, and they should not diverge once cropped. */
        setItemRefs((prev) =>
          prev.map((x) =>
            x.url === target.url ? { url: j.url as string, preview: dataUrl, view: x.view } : x,
          ),
        );
        setCropping(null);
      } catch (e) {
        // Must surface in the DIALOG: the page-level error sits behind the
        // modal, so a failure here used to look like nothing happening at all.
        console.error("[studio] crop failed:", e);
        setCropErr(e instanceof Error ? e.message : "Crop failed — please try again.");
      } finally {
        setCropBusy(false);
      }
    },
    [cropping],
  );

  // Paste an image from the clipboard (⌘/Ctrl+V) anywhere in Studio → item ref.
  // Guarded to image payloads only, so pasting text into inputs is untouched.
  /* Bulk Studio mounts many products on one page: a window-wide paste would land
     in every one of them, so pasting is a single-product (Studio tab) feature. */
  const pasteOff = Boolean(bulk);
  useEffect(() => {
    if (!canManage || pasteOff) return;
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imageFilesFromTransfer(e.clipboardData);
      if (imgs.length) {
        e.preventDefault();
        void uploadItems(imgs);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [canManage, pasteOff, uploadItems]);

  const startPhoneCamera = useCallback(async () => {
    setErr(null);
    // A session is already open: the click only changed the target section
    // (activeViewRef). Minting a second session here left the phone
    // uploading to the first one, where nothing was listening any more.
    if (qr) return;
    try {
      const r = await fetch("/api/image-handoff/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matrixId }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        sessionId?: string;
        scanUrl?: string;
        qrCodeUrl?: string;
        expiresAt?: number;
        error?: string;
      };
      if (!r.ok || !j.sessionId || !j.qrCodeUrl) throw new Error(j.error || "Could not start phone camera.");
      handoffSeenRef.current = new Set();
      sessionExpiresRef.current = Number(j.expiresAt) || Date.now() + 15 * 60_000;
      setQr({ url: j.qrCodeUrl, scanUrl: j.scanUrl || "", sessionId: j.sessionId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Phone camera failed");
    }
  }, [qr, matrixId]);

  const togglePanel = useCallback((p: number) => {
    setPanels((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p].sort()));
  }, []);

  /** High-detail vision pass over the item reference photos → numbered lock
   *  list (see /api/openai/item-spec). Stores the spec + the refs it covers. */
  /** Turn a stored reference upright on the server; resolves to the new URL. */
  const rotateStoredRef = useCallback(async (url: string, degrees: 90 | 180 | 270): Promise<string> => {
    const r = await fetch("/api/studio/rotate-ref", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, degrees }),
    });
    const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!r.ok || !j.url) throw new Error(j.error ?? `Rotate failed (HTTP ${r.status})`);
    return j.url;
  }, []);

  /** Swap rotated copies in for their originals (every section a photo is in).
   *  Turning a photo upright does not change what it shows, so a spec that
   *  covered the old photos still covers the new ones — no re-analysis. */
  const swapRefUrls = useCallback((swaps: Map<string, string>) => {
    const prev = itemRefsRef.current;
    const next = prev.map((x) => {
      const url = swaps.get(x.url);
      return url ? { url, preview: previewFor(url), view: x.view } : x;
    });
    const oldKey = refViewKey(groupRefs(prev));
    const newKey = refViewKey(groupRefs(next));
    itemRefsRef.current = next;
    setItemRefs(next);
    setSpecRefsKey((k) => (k === oldKey ? newKey : k));
  }, []);

  /** Thumbnail ⟳ — 90° clockwise per click. */
  const rotateRefByHand = useCallback(
    async (url: string) => {
      setRotatingUrl(url);
      setErr(null);
      try {
        const rotated = await rotateStoredRef(url, 90);
        swapRefUrls(new Map([[url, rotated]]));
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Rotate failed");
      } finally {
        setRotatingUrl(null);
      }
    },
    [rotateStoredRef, swapRefUrls],
  );

  const analyzeItem = useCallback(
    async (
      views: RefViewLists,
      signal?: AbortSignal,
    ): Promise<{ lockText: string; dropped: number; textReadings: { quoted: string; reading: string | null }[] } | null> => {
      const refUrls = orderedRefUrls(views);
      if (!refUrls.length) {
        setErr("Add at least one item photo before analyzing.");
        return null;
      }
      setSpecBusy(true);
      try {
        const r = await fetch("/api/openai/item-spec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemRefs: refUrls, itemRefViews: productViews(views), itemType, productName }),
          signal,
        });
        const j = (await r.json().catch(() => ({}))) as {
          lockText?: string;
          /** Second read of each quoted text — feeds the spec risk check below the spec. */
          textReadings?: { quoted: string; reading: string | null }[];
          error?: string;
          imagesAnalyzed?: number;
          imagesDropped?: number;
          imagesFailed?: number;
          failedViews?: RefView[];
          /** A FRONT/BACK section made of close-ups only (see the route). */
          photoWarnings?: string[];
          /** Photos lying sideways / upside down, with the clockwise turn. */
          photoRotations?: Array<{ url: string; degrees: 90 | 180 | 270 }>;
          /** Lines a second look at the photos corrected (flap buttons, fit). */
          specCorrections?: string[];
        };
        if (!r.ok || !j.lockText) throw new Error(j.error ?? "Item analysis failed");
        setItemSpec(j.lockText);
        setSpecTextReadings(Array.isArray(j.textReadings) ? j.textReadings : []);
        setSpecRefsKey(refViewKey(views));
        // Raw analyzer output — no human has corrected it (yet).
        setSpecConfirmed(false);
        const failed = Number(j.imagesFailed) || 0;
        // A photo the analysis could not open is a photo the spec knows nothing
        // about — say so, loudly, instead of letting the spec look complete.
        setErr(
          failed
            ? `${failed} photo${failed === 1 ? "" : "s"} (${(j.failedViews ?? []).join(", ") || "unknown section"}) could not be opened by the analysis — the spec does not cover ${failed === 1 ? "it" : "them"}. Re-upload and re-analyze, or check the spec by hand.`
            : null,
        );
        // A close-ups-only side is why a chest print comes back the size of the
        // back artwork — the one photo problem only the operator can fix.
        const photoWarnings = (j.photoWarnings ?? []).filter(Boolean);
        setPhotoWarn(photoWarnings.length ? photoWarnings.join(" ") : null);
        // Flat lays shot from above come out sideways / upside down (the phone
        // cannot tell which way is up). Straighten them here; nothing to re-take.
        const turns = (j.photoRotations ?? []).filter((t) => t?.url && [90, 180, 270].includes(t.degrees));
        if (turns.length) {
          const swaps = new Map<string, string>();
          for (const t of turns) {
            if (swaps.has(t.url)) continue;
            try {
              swaps.set(t.url, await rotateStoredRef(t.url, t.degrees));
            } catch (e) {
              console.warn("[studio] auto-rotate failed", t.url, e);
            }
          }
          if (swaps.size) {
            swapRefUrls(swaps);
            setMsg(`Straightened ${swaps.size} photo${swaps.size === 1 ? "" : "s"} that ${swaps.size === 1 ? "was" : "were"} lying sideways or upside down.`);
          }
        }
        const dropped = Number(j.imagesDropped) || 0;
        const corrected = (j.specCorrections ?? []).filter(Boolean);
        if (dropped || corrected.length) {
          setMsg(
            [dropped ? `Analyzed ${j.imagesAnalyzed} photos (${dropped} over the limit were skipped).` : "", ...corrected].filter(Boolean).join(" "),
          );
        }
        return { lockText: j.lockText, dropped, textReadings: Array.isArray(j.textReadings) ? j.textReadings : [] };
      } catch (e) {
        if (signal?.aborted) {
          setMsg("Aborted — the item analysis was cancelled.");
          return null;
        }
        setErr(e instanceof Error ? e.message : "Item analysis failed");
        return null;
      } finally {
        setSpecBusy(false);
      }
    },
    [itemType, productName, rotateStoredRef, swapRefUrls],
  );

  /* ── Night batch (lib/server/studio-batch.ts) ─────────────────────────────
     This product's queued / sent / finished batch runs, and what the whole
     queue holds for tonight. */
  const [batchItems, setBatchItems] = useState<BatchItemSummary[]>([]);
  const [batchOverview, setBatchOverview] = useState<BatchOverview | null>(null);
  /** An item id while its results load, or "send" / "check". */
  const [batchBusy, setBatchBusy] = useState<string | null>(null);
  const [confirmBatchSend, setConfirmBatchSend] = useState(false);
  /** The runTag of the last run generate("batch") queued — how Bulk Studio learns it worked. */
  const batchQueuedRef = useRef<string | null>(null);
  const refreshBatch = useCallback(async () => {
    try {
      const r = await fetch(`/api/studio/batch?matrixId=${encodeURIComponent(matrixId)}`, { cache: "no-store" });
      if (!r.ok) return;
      const j = (await r.json()) as { items?: BatchItemSummary[]; overview?: BatchOverview };
      setBatchItems(Array.isArray(j.items) ? j.items : []);
      setBatchOverview(j.overview ?? null);
    } catch {
      /* offline — the box keeps what it showed */
    }
  }, [matrixId]);
  const batchInFlight = batchItems.some((b) => b.status === "queued" || b.status === "preparing" || b.status === "submitted");
  useEffect(() => {
    if (!canManage) return;
    let alive = true;
    const tick = () => {
      if (alive) void refreshBatch();
    };
    tick();
    // While a run of this product is out, look again every 2 minutes.
    const t = batchInFlight ? window.setInterval(tick, 120_000) : null;
    return () => {
      alive = false;
      if (t) window.clearInterval(t);
    };
  }, [canManage, refreshBatch, batchInFlight]);

  /** Bring a finished batch run into the gallery, exactly like a live run's crops. */
  const loadBatchResults = useCallback(
    async (item: BatchItemSummary) => {
      setBatchBusy(item.id);
      setErr(null);
      try {
        const r = await fetch(`/api/studio/batch/${item.id}`, { cache: "no-store" });
        const j = (await r.json().catch(() => ({}))) as {
          runTag?: string;
          accessory?: boolean;
          panels?: { panel: number; poseA: number | null; poseB: number | null; imageBase64?: string; error?: string }[];
          error?: string;
        };
        if (!r.ok || !j.runTag || !j.panels) throw new Error(j.error || `Could not load the results (HTTP ${r.status})`);
        const tag = j.runTag;
        const note = "Rendered in the night batch — the consistency checks do not run on batch renders, so review it yourself.";
        const fresh: Crop[] = [];
        for (const p of j.panels) {
          const crops = await panelResponseToCrops(
            p.imageBase64 ? { imageBase64: p.imageBase64 } : { error: p.error || "not rendered" },
            p.panel,
            p.poseA ?? 0,
            p.poseB ?? 0,
            tag,
            j.accessory ? "Shot" : "Pose",
          );
          fresh.push(...crops.map((c) => (c.b64 ? { ...c, qaNotes: [...(c.qaNotes ?? []), note] } : c)));
        }
        // Loading the same run twice replaces it instead of doubling the gallery.
        setCrops((prev) => [...prev.filter((c) => !c.id.endsWith(`-${tag}`)), ...fresh]);
        await fetch(`/api/studio/batch/${item.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "loaded" }),
        }).catch(() => {});
        const got = fresh.filter((c) => c.b64).length;
        setMsg(`Loaded ${got} crop(s) from the night batch (${item.modelName ?? "model"}). Select what to keep, then push.`);
        void refreshBatch();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not load the batch results");
      } finally {
        setBatchBusy(null);
      }
    },
    [refreshBatch],
  );

  const removeBatchItem = useCallback(
    async (item: BatchItemSummary) => {
      setBatchBusy(item.id);
      try {
        const r = await fetch(`/api/studio/batch/${item.id}`, { method: "DELETE" });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(j.error || `Could not remove it (HTTP ${r.status})`);
        void refreshBatch();
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not remove it from the batch");
      } finally {
        setBatchBusy(null);
      }
    },
    [refreshBatch],
  );

  /** "Send now" (everything queued, every product) or "Check now". */
  const runBatchNow = useCallback(
    async (what: "send" | "check") => {
      setBatchBusy(what);
      setConfirmBatchSend(false);
      setErr(null);
      try {
        const r = await fetch(what === "send" ? "/api/studio/batch/run" : "/api/studio/batch/poll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trigger: "manual" }),
        });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok && r.status !== 409) throw new Error(j.error || `HTTP ${r.status}`);
        setMsg(
          r.status === 409
            ? "The batch is already being sent or checked — look again in a minute."
            : what === "send"
              ? "Sending the batch to OpenAI now — this box updates as it goes (results usually within a few hours)."
              : "Checking with OpenAI — finished runs show up here in a minute.",
        );
        window.setTimeout(() => void refreshBatch(), 20_000);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Could not reach the batch");
      } finally {
        setBatchBusy(null);
      }
    },
    [refreshBatch],
  );

  /**
   * `live` renders now. `batch` ("Add to tonight's batch") runs the same checks
   * and builds byte-for-byte the same panel requests, then queues them for the
   * 1 AM OpenAI batch (half price) instead of rendering — see
   * lib/server/studio-batch.ts. A batch run never waits on a live panel 1, and
   * a missing or outdated spec is analysed and used as is (owner, 2026-10-17).
   */
  const generate = useCallback(async (mode: "live" | "batch" = "live") => {
    if (!model) return setErr("Pick a model first.");
    const batch = mode === "batch";
    /* A batch press may analyse first, which can straighten photos — the run
       then uses the straightened copies. */
    let runViews = refViews;
    let refUrls = orderedRefUrls(runViews);
    if (!refUrls.length) {
      return setErr(
        itemRefs.length
          ? "Add a photo of the item itself to General, Front or Back — Style with holds only the pieces worn with it."
          : "Add at least one item photo (upload or phone camera).",
      );
    }
    if (!panels.length) return setErr("Select at least one panel.");
    if (refViews.styling.length > MAX_STYLING_REFS) {
      return setErr(`Style with holds up to ${MAX_STYLING_REFS} photos — remove ${refViews.styling.length - MAX_STYLING_REFS}.`);
    }
    /* A back-facing pose of a back nobody has seen is a guess the operator
       pays for. Ask for a Back photo — or the operator's word that the back
       is plain — before spending anything. The server enforces the same. */
    const backPanels = accessoryKind
      ? []
      : panels.filter((p) => getPanelPosePair(model.gender, p).some((pose) => isBackFacingPose(model.gender, pose)));
    // Same rule as the server: a Back photo, the operator's word, or a spec
    // that itself establishes the back (a design, or "plain").
    const backKnown = refViews.back.length > 0 || backIsPlain || specSaysBackDesign || specBack === "plain";
    if (backPanels.length && !backKnown) {
      return setErr(
        `Panel ${backPanels.join(" and ")} shows the BACK of the item. Add a photo to the Back section, or tick "The back is plain" after checking the real garment.`,
      );
    }
    setErr(null);
    setMsg(null);
    if (!batch) {
      // A new run replaces any run still holding panels behind a flagged panel 1.
      setHeldRun(null);
      forceFollowersRef.current = null;
    }
    /* Step 1 of a new product: analyze the photos and STOP, so the spec can be
       read and corrected before four panels are paid for. Once the spec exists
       for exactly these photos, Generate goes straight through. */
    // The stopwatch runs from this click, whichever branch the press takes.
    if (!batch) setClock({ startedAt: Date.now(), endedAt: null });
    const abort = new AbortController();
    abortRef.current = { controller: abort, jobIds: [] };
    setAborting(false);
    let specForRun = itemSpec.trim();
    let specConfirmedRun = specConfirmed;
    /** Said with the "queued" message: red lines on a spec nobody has read yet. */
    let batchSpecNote = "";
    const endBatchPrep = () => {
      abortRef.current = null;
      setAborting(false);
      setBusy(null);
      setProgress("");
    };
    if (specStale && batch) {
      setBusy("batch");
      setProgress("Analyzing item details before adding to the batch…");
      const analyzed = await analyzeItem(refViews, abort.signal);
      if (!analyzed) return endBatchPrep();
      runViews = groupRefs(itemRefsRef.current);
      refUrls = orderedRefUrls(runViews);
      specForRun = analyzed.lockText.trim();
      specConfirmedRun = false;
      const freshBack = parseSpecBackState(specForRun);
      const freshBackKnown =
        runViews.back.length > 0 || backIsPlain || freshBack === "design" || freshBack === "plain" || specListsBackDesign(specForRun);
      if (backPanels.length && !freshBackKnown) {
        endBatchPrep();
        return setErr(
          `Item spec ready — but panel ${backPanels.join(" and ")} shows the BACK and nothing shows the back. Add a Back photo or tick "The back is plain", then add to the batch again.`,
        );
      }
      const risk = specRiskReport(specForRun, {
        productName,
        itemType,
        isAccessory: Boolean(accessoryKind),
        refCount: refUrls.length,
        specConfirmed: false,
        textReadings: analyzed.textReadings,
      });
      if (risk.blocking.length) {
        batchSpecNote = ` The new spec has ${risk.blocking.length} red line${risk.blocking.length === 1 ? "" : "s"} — it was queued as is; read them below.`;
      }
    } else if (specStale) {
      setBusy("analyze");
      setProgress("Analyzing item details (text, graphics, materials, hardware, stitching)…");
      try {
        const analyzed = await analyzeItem(refViews, abort.signal);
        if (analyzed) {
          setMsg(
            `Item spec ready${analyzed.dropped ? ` (${analyzed.dropped} photos over the limit were skipped)` : ""} — read it below and fix anything wrong (especially the BACK line), then press Generate.`,
          );
        }
      } finally {
        abortRef.current = null;
        setAborting(false);
        setBusy(null);
        setProgress("");
        setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
      }
      return;
    }
    /* The spec contradicts the product's own name ("Double Pleated" trouser,
       spec says "no pleat"). Every panel would render the contradiction. */
    else if (specBlocked) {
      abortRef.current = null;
      setClock(null);
      return setErr(
        `The spec contradicts the product (red lines under the spec). Fix those lines, or tick "I checked the spec" if the spec is right — nothing was generated.`,
      );
    }
    setBusy(batch ? "batch" : "generate");
    if (!batch) setNativeBusy(true);
    // Regenerate flow (carbon-gen): keep the crops you selected, append fresh
    // ones below; unselected old crops are dropped. runTag keeps ids unique.
    const kept = crops.length > 0 ? crops.filter((c) => c.selected && c.b64) : [];
    const runTag = Date.now().toString(36);
    const chosen = [...panels].sort((a, b) => a - b);
    /* Pinned for the whole run: the operator switching the colour dropdown
       mid-generation must not leave panel 3 rendering a different colourway
       from panel 1. */
    const activeColorRun = colorRun?.colorRefUrl ? colorRun : null;
    // One facial expression per run so the model doesn't look robotic across
    // products; kept consistent across this run's panels for set coherence.
    const expressionDirective = pickExpressionDirective();
    /* The non-product styling, resolved ONCE and sent to all four panels. Each
       panel is a separate API call that cannot see the others, so naming the
       t-shirt and the shoes here is the only thing that makes the set look
       like one shoot instead of four. */
    /* Dress the model in what the item photos show (the analyser's OUTFIT
       lines), and only fall back to streetwear defaults for the pieces they do
       not show. The defaults pick their colour against the product's, which is
       the colourway being rendered when there is one. */
    const garmentColour = /^\s*\d+\.\s*Garment:[^—\n]*—\s*([^\n.]+)/m.exec(specForRun)?.[1] ?? "";
    const itemColour = activeColorRun?.colorName || garmentColour || color;
    /* An accessory pins this for the whole run, like the colourway: switching
       the item type mid-run must not mix shots and poses in one set. */
    const runAccessory = accessoryKind;
    /* Style with: name the operator's pieces so the lock can name them — a piece
       the prompt only points at loses to the lock's named default tee. Read once
       per set of photos; a run that cannot read them stops rather than paying
       for four panels that would ignore them. */
    const hasStyleWith = runViews.styling.length > 0;
    let styleWith: Partial<Record<OutfitSlot, string>> = {};
    if (hasStyleWith) {
      const key = runViews.styling.join("|") + "::" + itemType;
      const cached = stylePiecesRef.current.get(key);
      if (cached) styleWith = cached;
      else {
        setProgress("Reading the Style with photos…");
        try {
          const r = await fetch("/api/openai/style-pieces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abort.signal,
            body: JSON.stringify({ urls: runViews.styling, itemType }),
          });
          const j = (await r.json().catch(() => ({}))) as { outfit?: Partial<Record<OutfitSlot, string>>; error?: string };
          if (!r.ok || !j.outfit) throw new Error(j.error || "Could not read the Style with photos");
          styleWith = j.outfit;
          stylePiecesRef.current.set(key, styleWith);
          const read = styleWith;
          setReadCache((c) => ({ ...c, style: { ...c.style, [key]: read } }));
        } catch (e) {
          abortRef.current = null;
          setBusy(null);
          setNativeBusy(false);
          setProgress("");
          setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
          return setErr(
            abort.signal.aborted
              ? "Aborted."
              : `${e instanceof Error ? e.message : "Could not read the Style with photos"} — nothing was generated. Try again, or remove the Style with photos.`,
          );
        }
      }
    }
    /* Styling words in the item instruction ("STYLE IT DRESSY") are turned into
       concrete pieces ONCE — left as words, each panel invented its own dressy
       outfit. A run that cannot read them stops before anything is paid for. */
    const instr = instruction.trim();
    let instructionStyling: ResolvedStyling | null = null;
    if (instr && instructionHasStyling(instr)) {
      const key = [instr, itemType, model.gender, itemColour].join("::");
      if (lookResolveRef.current.has(key)) instructionStyling = lookResolveRef.current.get(key) ?? null;
      else {
        setProgress("Reading the styling in the item instruction…");
        try {
          const r = await fetch("/api/openai/look-resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: abort.signal,
            body: JSON.stringify({ instruction: instr, itemType, gender: model.gender, itemColour, productName }),
          });
          const j = (await r.json().catch(() => ({}))) as { styling?: ResolvedStyling | null; error?: string };
          if (!r.ok || !("styling" in j)) throw new Error(j.error || "Could not read the styling in the item instruction");
          instructionStyling = j.styling ?? null;
          lookResolveRef.current.set(key, instructionStyling);
          const read = instructionStyling;
          setReadCache((c) => ({ ...c, styling: { ...c.styling, [key]: read } }));
        } catch (e) {
          abortRef.current = null;
          setBusy(null);
          setNativeBusy(false);
          setProgress("");
          setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
          return setErr(
            abort.signal.aborted
              ? "Aborted."
              : `${e instanceof Error ? e.message : "Could not read the styling in the item instruction"} — nothing was generated. Try again.`,
          );
        }
      }
    }
    /* Shoes the note names that the reader missed become the named footwear
       (owner 2026-10-19: "white sneakers" was read as no shoes at all). */
    instructionStyling = withNoteFootwear(instructionStyling, instr);
    /* Everything the model wears that is not the product, decided here once
       and sent byte-for-byte to every panel (the server puts it in the part of
       the prompt that is never trimmed). The seed is per product + model +
       colour, so a re-run dresses the model the same way. */
    const lookColour = color || itemColour;
    const look = resolveLookSheet({
      itemType,
      gender: model.gender === "female" ? "female" : "male",
      productName,
      specOutfit: parseOutfitFromSpec(specForRun),
      styleWith,
      instructionStyling,
      itemColour,
      accessoryKind: runAccessory,
      seedKey: `${matrixId}|${model.model_id}|${lookColour}`,
      keepStylingPrints,
      backWaistbandLabel: !runAccessory && needsBackWaistbandTuck(itemType, specForRun),
    });
    /* The note and the look sheet disagree (a piece the note mentions is taken
       from a photo): every separately rendered panel would settle it its own way.
       Stop once and say so; pressing again with the same setup goes ahead. */
    const conflicts = lookConflicts(instr, look);
    const conflictKey = conflicts.length ? `${look.text}::${instr}` : "";
    if (conflicts.length && conflictAckRef.current !== conflictKey) {
      conflictAckRef.current = conflictKey;
      abortRef.current = null;
      setAborting(false);
      setBusy(null);
      setNativeBusy(false);
      setProgress("");
      setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
      return setErr(`${conflicts.join(" ")} Nothing was generated. Fix the instruction or the Style-with photo — or press the same button again to go ahead anyway.`);
    }
    /* One pose-variation seed for the whole run (a colourway keeps its stored
       one); every panel used to take the second its request arrived. */
    const runSeed = activeColorRun ? activeColorRun.variationSeed : stableLsSystemIdFromString(`${matrixId}|${runTag}`);
    /* Panel 1 sets the look: it renders first, the others wait for it on the
       server and render with it attached. Only garment runs that include panel 1
       and at least one other panel. */
    const anchored = !batch && matchPanel1 && !runAccessory && chosen.includes(1) && chosen.length > 1;
    /* A re-render without panel 1 attaches the saved panel 1 for this model and
       colour, so the new crops match the ones already kept. */
    const savedLook =
      !anchored && keepLook && !runAccessory && !chosen.includes(1) ? lookAnchors[lookAnchorKeyFor(model.model_id, lookColour)] : undefined;
    const lookAnchorUrl = savedLook && savedLook.gate !== "flagged" && savedLook.url ? savedLook.url : undefined;
    /** One panel's request — exactly what /api/generate receives, live or in the night batch. */
    const panelRequest = (panel: number) => {
      const [poseA, poseB] = runAccessory ? accessoryShotPair(panel) : getPanelPosePair(model.gender, panel);
      const panelLabel = runAccessory ? accessoryPanelLabel(panel) : getPanelButtonLabel(model.gender, panel);
      const prompt = runAccessory
        ? buildAccessoryPanelPrompt({
            kind: runAccessory,
            panelNumber: panel,
            modelName: model.name,
            modelGender: model.gender,
            itemType,
            itemColour,
            itemStyleInstructions: instruction,
            expressionDirective,
            stylingLock: "",
            hasStyleWith,
            lookSheetInServer: true,
            lookSeed: look.seed,
          })
        : buildMasterPanelPrompt({
        panelNumber: panel,
        panelLabel,
        poseA,
        poseB,
        modelName: model.name,
        modelGender: model.gender,
        modelRefs: model.ref_image_urls,
        itemRefs: refUrls,
        itemType,
        itemStyleInstructions: instruction,
        expressionDirective,
        // The LOOK SHEET (below, in the request) replaces the per-panel styling lock.
        stylingLock: "",
        lookSheetInServer: true,
        // Same seed as the request's: the pose blocks lose their "pick ONE" menus,
        // settled in code to agree with the server's POSE VARIATION.
        variationSeed: runSeed,
        hasStyleWith,
        // itemSpec travels as its own request field (server appends it inside the
        // protected lock block) — NOT inside the prompt, which is near the
        // model's length limit and gets trimmed from the middle.
      });
      const body = {
        prompt,
        size: "1536x1024",
        modelRefs: model.ref_image_urls,
        itemRefs: refUrls,
        itemRefViews: runViews,
        panelQa: { panelNumber: panel, panelLabel, poseA, poseB, modelName: model.name, modelGender: model.gender, itemType, accessoryKind: runAccessory ?? "" },
        itemSpec: specForRun || undefined,
        matrixId,
        backIsPlain,
        // true = a human edited the spec text; false = raw analyzer output.
        specConfirmed: specConfirmedRun,
        /* Sent on its own as well as inside the prompt, so the server can
           give it the last word — see app/api/generate/route.ts. */
        instruction: instruction.trim() || undefined,
        /* The run's outfit, identical in every panel; the seed for pose
           variation, one per run (a colourway's stored seed keeps its poses
           away from the colours already generated). */
        lookSheet: look.text,
        variationSeed: runSeed,
        /* Which saved look this run's panel 1 becomes (model + colour). */
        modelId: model.model_id,
        itemColour: lookColour,
        ...(lookAnchorUrl ? { lookAnchorUrl } : {}),
        /* The picked jeans label: the server attaches it to the Pose 4 / Pose 7
           panels when the spec puts a label on the back waistband. */
        ...(isJeansType && jeansLabelId && !runAccessory ? { jeansLabelId } : {}),
        /* A colourway on file turns this into a dye change: same analysis,
           same construction, new cloth colour, with that colour's own photo
           attached. */
        ...(activeColorRun
          ? {
              colorOverride: {
                name: activeColorRun.colorName,
                refUrl: activeColorRun.colorRefUrl,
                hardwareNote: activeColorRun.hardwareNote,
              },
            }
          : {}),
      };
      return { poseA, poseB, body };
    };
    if (batch) {
      try {
        setProgress(`Adding ${chosen.length} panel(s) to tonight's batch…`);
        const r = await fetch("/api/studio/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: abort.signal,
          body: JSON.stringify({
            matrixId,
            runTag,
            modelName: model.name,
            modelGender: model.gender,
            itemColour: lookColour,
            itemType,
            panels: chosen.map((panel) => ({ panel, body: panelRequest(panel).body })),
          }),
        });
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        if (!r.ok) throw new Error(j.error || `Could not add to the batch (HTTP ${r.status})`);
        batchQueuedRef.current = runTag;
        setMsg(
          `Added ${chosen.length} panel(s) with ${model.name} to tonight's batch — it goes to OpenAI at 1 AM Eastern at half price; the pictures are saved to Dropbox (Campaign › 2026 OPENAI GENERATOR WMS) and show up here, usually by morning. Nothing is published until you push.${batchSpecNote}`,
        );
        void refreshBatch();
      } catch (e) {
        setErr(abort.signal.aborted ? "Aborted — nothing was added to the batch." : e instanceof Error ? e.message : "Could not add to the batch");
      } finally {
        endBatchPrep();
      }
      return;
    }
    setProgress(
      anchored
        ? `Panel 1 sets the look — panel${chosen.length > 2 ? "s" : ""} ${chosen.filter((p) => p !== 1).join(", ")} follow (about 3 minutes)…`
        : lookAnchorUrl
          ? `Generating ${chosen.length} panel(s) to match the saved look…`
          : `Generating ${chosen.length} panel(s) in parallel…`,
    );
    // Touch devices only: keep the screen awake while the panels generate — a
    // locked phone suspends the page and aborts the in-flight fetches, which
    // surfaces as "failed" panels / missing poses. Desktop never requests one.
    let wakeLock: WakeLockSentinel | null = null;
    try {
      if (window.matchMedia("(pointer: coarse)").matches && "wakeLock" in navigator) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch {
      /* unavailable (low battery, older iOS) — generation proceeds without it */
    }

    // One job id per panel, written down BEFORE the first request: if this page
    // is frozen or discarded mid-run (app switch, phone lock, tab evicted) the
    // renders keep going server-side and these ids are how we get them back.
    const jobIds = new Map<number, string>(chosen.map((p) => [p, newJobId(runTag, p)]));
    abortRef.current = { controller: abort, jobIds: [...jobIds.values()] };
    const startedAt = Date.now();
    writePendingRun({
      matrixId,
      runTag,
      gender: model.gender,
      accessory: Boolean(runAccessory),
      anchored,
      startedAt,
      jobs: chosen.map((p) => ({ panel: p, jobId: jobIds.get(p)! })),
    });

    /* One panel, start to finish. `force` re-sends a follower that was held
       because panel 1's check flagged it ("Render the other panels anyway"). */
    const genOnePanel = async (
      panel: number,
      opts: { jobId: string; signal: AbortSignal; force?: boolean },
    ): Promise<{ crops: Crop[]; json: PanelResponse | null }> => {
      const { jobId, signal } = opts;
      const { poseA, poseB, body } = panelRequest(panel);
      const follower = anchored && panel !== 1;
      const deadline = Date.now() + (follower ? FOLLOWER_POLL_TIMEOUT_MS : JOB_POLL_TIMEOUT_MS);
      let json: PanelResponse | null = null;
      try {
        const resp = await fetch("/api/generate", {
          method: "POST",
          // x-generate-stream: the server heartbeats whitespace every 10s while
          // OpenAI works so mobile networks / iOS don't drop the otherwise-idle
          // 60-90s connection ("Load failed"). Leading whitespace is valid JSON.
          // x-generate-job: run it detached from this connection so backgrounding
          // the app/tab can't cancel the render — we claim the result below.
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "x-generate-stream": "1",
            "x-generate-job": jobId,
            // Hold this panel for the run-level judges. They compare the frames
            // with each other, so they can only run once the whole run is in.
            "x-generate-run": runTag,
          },
          signal,
          body: JSON.stringify({
            ...body,
            ...(anchored ? { anchor: { runId: runTag, role: panel === 1 ? "source" : "follower", ...(opts.force ? { force: true } : {}) } } : {}),
          }),
        });
        const parsed = (await resp.json().catch(() => null)) as PanelResponse | null;
        // A body that says nothing useful means the stream was cut mid-flight
        // (frozen page, dropped carrier connection) — go claim the real result.
        json = parsed && (parsed.imageBase64 || parsed.error || parsed.degraded) ? parsed : null;
      } catch {
        json = null; // connection died — the render is still running server-side
      }
      // Aborted: the panel's job was cancelled server-side; it shows nothing.
      if (signal.aborted) return { crops: [], json: null };
      if (!json) json = await claimPanelJob(jobId, deadline, signal);
      else releasePanelJob(jobId);
      if (signal.aborted) return { crops: [], json: null };
      /* Panel 1 became this product's saved look for the model + colour. */
      const saved = json?.lookAnchor;
      if (saved?.url && saved.key) {
        setLookAnchors((prev) => ({ ...prev, [saved.key!]: { url: saved.url!, gate: saved.gate ?? null, runTag } }));
      }
      return { crops: await panelResponseToCrops(json, panel, poseA, poseB, runTag, runAccessory ? "Shot" : "Pose"), json };
    };

    try {
      /* Every panel starts AT ONCE, and each one's crops appear the moment it
         lands instead of after the slowest. Panels differ by 30-90 s, so
         waiting for all four meant staring at an empty gallery for the whole
         run. Results are kept in panel order so the grid fills in place
         rather than shuffling as they arrive. */
      setCrops(kept);
      /* `byPanel` is the authority while the run is in flight: each re-render
         rebuilds the gallery from it, so a QA verdict must be written here too
         — a verdict applied only to React state would be wiped by the next
         panel's re-render. Once the run is over there are no more rebuilds and
         late verdicts go straight to state, which also protects any selection
         the operator has since toggled. */
      const byPanel = new Map<number, Crop[]>();
      const render = () => {
        const ordered = chosen.filter((p) => byPanel.has(p)).flatMap((p) => byPanel.get(p)!);
        setCrops([...kept, ...ordered]);
      };
      /* Followers held because panel 1's check flagged it: nothing was paid for
         them; they wait for the operator's word. */
      const held: number[] = [];
      let heldFindings: string[] = [];
      await Promise.all(
        chosen.map(async (panel) => {
          try {
            const res = await genOnePanel(panel, { jobId: jobIds.get(panel)!, signal: abort.signal });
            const perr = panelErrorOf(res.json);
            if (perr?.type === "anchor_flagged") {
              held.push(panel);
              if (!heldFindings.length) {
                heldFindings = (perr.findings ?? []).map((f) => String(f?.text ?? "").trim()).filter(Boolean);
                if (!heldFindings.length && perr.message) heldFindings = [perr.message];
              }
              byPanel.set(panel, []);
            } else {
              byPanel.set(panel, res.crops);
            }
          } catch (e) {
            if (abort.signal.aborted) {
              byPanel.set(panel, []);
              return;
            }
            byPanel.set(panel, [
              {
                id: `p${panel}-fail-${runTag}`,
                b64: "",
                label: `Panel ${panel}: ${e instanceof Error ? e.message : "failed"}`,
                selected: false,
              },
            ]);
          }
          render();
          const done = byPanel.size;
          const got = [...byPanel.values()].flat().filter((c) => c.b64).length;
          setProgress(
            done < chosen.length
              ? `Panel ${done} of ${chosen.length} done — ${got} crop(s) ready, still rendering…`
              : "",
          );
        }),
      );
      const all = [...byPanel.values()].flat();
      if (abort.signal.aborted) {
        render();
        const got = all.filter((c) => c.b64).length;
        setMsg(
          `Aborted — generation cancelled.${got ? ` ${got} crop(s) that had already finished are kept (not checked).` : ""}`,
        );
        setCrops((prev) => prev.map((c) => (c.qaPending ? { ...c, qaPending: false } : c)));
        return;
      }

      /* Every panel is in, so the judges can finally do the only comparison
         that matters: these frames against each other, and the garment against
         the photographs. The images stay on screen and selected while this
         runs — a flag arriving late unselects just the crop it names. */
      const checkRun = async (signal: AbortSignal) => {
        setProgress("Checking the crops for consistency…");
        await collectRunQa(runTag, (v) => {
          if (signal.aborted) {
            setMsg("Aborted — the consistency checks were cancelled. Review the crops yourself.");
            setCrops((prev) => prev.map((c) => (c.qaPending ? { ...c, qaPending: false } : c)));
            return;
          }
          setCrops((prev) =>
            prev.map((c) => {
              if (!c.qaPending) return c;
              if (!v) {
                return {
                  ...c,
                  qaPending: false,
                  qaNotes: [...(c.qaNotes ?? []), "The checks did not report back — review this crop yourself."],
                };
              }
              const mine = v.findings
                .filter((f) => f.panel === c.panel && (f.frame === "both" || f.frame === c.side))
                .map((f) => f.text);
              const warnings = mine.length ? mine : undefined;
              const advice = v.advisories
                .filter((f) => f.panel === c.panel && (f.frame === "both" || f.frame === c.side))
                .map((f) => f.text);
              const notes = [
                ...(c.qaNotes ?? []),
                ...advice,
                ...v.notes,
                ...(v.unavailable ? ["The checks were inconclusive — this crop was not verified."] : []),
              ];
              return {
                ...c,
                qaPending: false,
                qaWarnings: warnings,
                qaNotes: notes.length ? notes : undefined,
                // A flagged crop must not stay selected for publishing.
                selected: warnings ? false : c.selected,
              };
            }),
          );
        }, signal);
        setProgress("");
      };

      if (held.length) {
        /* Panel 1 is shown with what its check found, unselected; the run-level
           judges wait until the operator decides (the server keeps panel 1). */
        const findings = heldFindings.length ? heldFindings : ["The panel 1 check flagged this render."];
        setCrops((prev) =>
          prev.map((c) =>
            c.panel === 1 && c.id.endsWith(`-${runTag}`)
              ? { ...c, qaPending: false, qaWarnings: findings, selected: false }
              : c,
          ),
        );
        const savedKey = lookAnchorKeyFor(model.model_id, lookColour);
        setLookAnchors((prev) => (prev[savedKey] ? { ...prev, [savedKey]: { ...prev[savedKey], gate: "flagged" } } : prev));
        const followers = [...held].sort((a, b) => a - b);
        setHeldRun({ runTag, sourcePanel: 1, followers, findings });
        setMsg(
          `Panel 1's check flagged it, so panel${followers.length > 1 ? "s" : ""} ${followers.join(", ")} ${followers.length > 1 ? "were" : "was"} held — nothing was paid for ${followers.length > 1 ? "them" : "it"}. Look at panel 1, then render the others anyway or regenerate panel 1.`,
        );
        /* "Render the other panels anyway": the same run, new job ids, force. */
        forceFollowersRef.current = async () => {
          setHeldRun(null);
          forceFollowersRef.current = null;
          const fAbort = new AbortController();
          const fJobs = new Map<number, string>(followers.map((p) => [p, newJobId(runTag, p)]));
          abortRef.current = { controller: fAbort, jobIds: [...fJobs.values()] };
          setAborting(false);
          setErr(null);
          setBusy("generate");
          setNativeBusy(true);
          setClock({ startedAt: Date.now(), endedAt: null });
          setProgress(`Rendering panel${followers.length > 1 ? "s" : ""} ${followers.join(", ")} to match panel 1…`);
          writePendingRun({
            matrixId,
            runTag,
            gender: model.gender,
            accessory: false,
            anchored: true,
            startedAt: Date.now(),
            jobs: followers.map((p) => ({ panel: p, jobId: fJobs.get(p)! })),
          });
          setLookAnchors((prev) => (prev[savedKey] ? { ...prev, [savedKey]: { ...prev[savedKey], gate: "forced" } } : prev));
          // Panel 1 joins the run-level check with its followers.
          setCrops((prev) => prev.map((c) => (c.panel === 1 && c.id.endsWith(`-${runTag}`) && c.b64 ? { ...c, qaPending: true } : c)));
          try {
            const results = await Promise.all(
              followers.map(async (panel) => {
                try {
                  return (await genOnePanel(panel, { jobId: fJobs.get(panel)!, signal: fAbort.signal, force: true })).crops;
                } catch (e) {
                  return fAbort.signal.aborted
                    ? []
                    : [{ id: `p${panel}-fail-${runTag}`, b64: "", label: `Panel ${panel}: ${e instanceof Error ? e.message : "failed"}`, selected: false }];
                }
              }),
            );
            const fresh = results.flat();
            setCrops((prev) => [...prev, ...fresh]);
            if (fAbort.signal.aborted) {
              setMsg("Aborted — generation cancelled.");
              setCrops((prev) => prev.map((c) => (c.qaPending ? { ...c, qaPending: false } : c)));
              return;
            }
            setMsg(`Generated ${fresh.filter((c) => c.b64).length} crop(s) matching panel 1. Select what to keep, then push.`);
            await checkRun(fAbort.signal);
          } finally {
            abortRef.current = null;
            setAborting(false);
            writePendingRun(null);
            setNativeBusy(false);
            setBusy(null);
            setProgress("");
            setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
          }
        };
        return;
      }

      setMsg(`Generated ${all.filter((c) => c.b64).length} crop(s). Select what to keep, then push${kept.length ? ` (kept ${kept.length})` : ""}.`);
      if (all.some((c) => c.qaPending && c.b64)) await checkRun(abort.signal);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generation failed");
    } finally {
      abortRef.current = null;
      setAborting(false);
      writePendingRun(null);
      setNativeBusy(false);
      setBusy(null);
      setProgress("");
      // Stop the stopwatch — the last panel is in.
      setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
      void wakeLock?.release().catch(() => {});
    }
  }, [model, itemRefs, refViews, panels, itemType, instruction, crops, matrixId, itemSpec, specStale, specBack, specSaysBackDesign, backIsPlain, specConfirmed, specBlocked, analyzeItem, colorRun, color, accessoryKind, productName, keepStylingPrints, matchPanel1, keepLook, lookAnchors, isJeansType, jeansLabelId, refreshBatch]);

  /**
   * Resume a run whose page was thrown away mid-flight (tab discarded under
   * memory pressure, app killed while backgrounded). The panels kept rendering
   * server-side; claim them instead of making the operator generate again.
   */
  const resumeStartedRef = useRef(false);
  useEffect(() => {
    if (resumeStartedRef.current) return;
    const run = readPendingRun(matrixId);
    if (!run) return;
    resumeStartedRef.current = true;
    let cancelled = false;
    const abort = new AbortController();
    abortRef.current = { controller: abort, jobIds: run.jobs.map((j) => j.jobId) };
    void (async () => {
      setBusy("generate");
      setNativeBusy(true);
      setProgress(`Reconnecting to ${run.jobs.length} panel(s) still generating…`);
      try {
        const deadline = Math.min(
          Date.now() + (run.anchored ? FOLLOWER_POLL_TIMEOUT_MS : JOB_POLL_TIMEOUT_MS),
          run.startedAt + JOB_MAX_AGE_MS,
        );
        const settled = await Promise.allSettled(
          run.jobs.map(async ({ panel, jobId }) => {
            const [poseA, poseB] = run.accessory ? accessoryShotPair(panel) : getPanelPosePair(run.gender, panel);
            const json = await claimPanelJob(jobId, deadline, abort.signal);
            if (abort.signal.aborted) return [];
            return panelResponseToCrops(json, panel, poseA, poseB, run.runTag, run.accessory ? "Shot" : "Pose");
          }),
        );
        if (cancelled) return;
        if (abort.signal.aborted) {
          const kept = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : [])).filter((c) => c.b64);
          setCrops((prev) => [...prev, ...kept.map((c) => ({ ...c, qaPending: false }))]);
          setMsg("Aborted — the interrupted run was cancelled.");
          return;
        }
        const recovered = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
        const ok = recovered.filter((c) => c.b64);
        setCrops((prev) => [...prev, ...recovered]);
        setMsg(
          ok.length
            ? `Recovered ${ok.length} crop(s) from the run that was interrupted.`
            : "The interrupted run could not be recovered — please generate again.",
        );
        /* The server may still be holding this run's panels, in which case the
           recovered crops can be checked exactly like a fresh run. If it is
           not, the crops say so rather than looking verified. */
        const pending = recovered.filter((c) => c.qaPending && c.b64);
        if (pending.length) {
          setProgress(`Checking ${pending.length} recovered crop(s) for consistency…`);
          await collectRunQa(run.runTag, (v) => {
            if (cancelled) return;
            setCrops((prev) =>
              prev.map((c) => {
                if (!c.qaPending) return c;
                if (!v) {
                  return {
                    ...c,
                    qaPending: false,
                    qaNotes: [...(c.qaNotes ?? []), "The checks did not report back — review this crop yourself."],
                  };
                }
                const mine = v.findings
                  .filter((f) => f.panel === c.panel && (f.frame === "both" || f.frame === c.side))
                  .map((f) => f.text);
                const warnings = mine.length ? mine : undefined;
                const advice = v.advisories
                  .filter((f) => f.panel === c.panel && (f.frame === "both" || f.frame === c.side))
                  .map((f) => f.text);
                const notes = [
                  ...(c.qaNotes ?? []),
                  ...advice,
                  ...v.notes,
                  ...(v.unavailable ? ["The checks were inconclusive — this crop was not verified."] : []),
                ];
                return {
                  ...c,
                  qaPending: false,
                  qaWarnings: warnings,
                  qaNotes: notes.length ? notes : undefined,
                  selected: warnings ? false : c.selected,
                };
              }),
            );
          }, abort.signal);
        }
      } finally {
        if (abortRef.current?.controller === abort) abortRef.current = null;
        setAborting(false);
        writePendingRun(null);
        setNativeBusy(false);
        setBusy(null);
        setProgress("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matrixId]);

  // ---- Media manager (matches carbon-gen's Publish step) ----
  // Auto-fill alt text for any image that's missing it (silent background pass);
  // the operator can still edit/regenerate per image afterwards.
  const autoAltMissing = useCallback(
    async (list: MediaItem[]) => {
      const missing = list.filter((m) => !m.alt.trim());
      if (!missing.length) return;
      const results = await Promise.allSettled(
        missing.map(async (m) => {
          const r = await fetch("/api/openai/image-alt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: m.url, itemType }),
          });
          const j = (await r.json().catch(() => ({}))) as { alt?: string; altText?: string };
          return { key: m.key, alt: (j.alt || j.altText || "").trim() };
        }),
      );
      const alts = new Map<string, string>();
      for (const res of results) if (res.status === "fulfilled" && res.value.alt) alts.set(res.value.key, res.value.alt);
      if (alts.size)
        setMediaItems((prev) => prev.map((m) => (alts.has(m.key) && !m.alt.trim() ? { ...m, alt: alts.get(m.key) as string } : m)));
    },
    [itemType],
  );

  const openMediaManager = useCallback(async () => {
    setMediaBusy("load");
    setErr(null);
    try {
      const r = await fetch(`/api/shopify/media?matrixId=${matrixId}`);
      const j = (await r.json().catch(() => ({}))) as { media?: Array<{ id: string; url: string; alt: string }> };
      const existing: MediaItem[] = (j.media || []).map((m) => ({
        key: `ex-${m.id}`,
        kind: "existing",
        mediaId: m.id,
        url: m.url,
        alt: m.alt || "",
        color: "",
      }));
      setShopifyExisting(existing);
      // Only the SELECTED generated crops are shown by default. Base order is
      // carbon-gen's canonical push order — ascending POSE NUMBER (the female
      // panels render 7+5 / 6+8, so generation order ≠ pose order) — then the
      // gender rule is applied on top:
      //  • MEN → Pose 4 LAST, Pose 7 second-to-last (8b3787c).
      //  • WOMEN → Pose 2 LAST so Pose 1 leads / becomes hero (9942a07). The
      //    previous implementation pushed EVERY right-frame crop last
      //    (1,3,7,6,2,4,5,8) — that was a bug against its own spec.
      const picked = crops.filter((c) => c.selected && c.b64);
      const poseNum = (c: Crop) => {
        const m = c.label.match(/(?:Pose|Shot) (\d+)/);
        return m ? Number(m[1]) : 0;
      };
      /* Accessory sets are pushed in shot order: Shot 1, the hero, becomes the
         main image, and the gender rules for garment poses do not apply. */
      const isShotSet = picked.some((c) => / · Shot \d+/.test(c.label));
      const isMale = (model?.gender || "").toLowerCase() === "male";
      const rank = isShotSet
        ? () => 0
        : isMale
        ? (c: Crop) => (poseNum(c) === 4 ? 2 : poseNum(c) === 7 ? 1 : 0)
        : (c: Crop) => (poseNum(c) === 2 ? 1 : 0);
      const ordered = [...picked].sort((a, b) => rank(a) - rank(b) || poseNum(a) - poseNum(b));
      const news: MediaItem[] = ordered.map((c) => ({
        key: `new-${c.id}`,
        kind: "new",
        b64: c.b64,
        url: `data:image/png;base64,${c.b64}`,
        alt: "",
        color: "",
      }));
      const seed = includeShopify ? [...existing, ...news] : news;
      setMediaItems(seed);
      setShowMedia(true);
      void autoAltMissing(seed);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load media");
    } finally {
      setMediaBusy(null);
    }
  }, [matrixId, crops, includeShopify, autoAltMissing, model]);

  // Toggle existing Shopify pictures in/out of the manager without losing edits
  // to the newly-generated ones.
  const toggleIncludeShopify = useCallback(() => {
    setIncludeShopify((v) => {
      const next = !v;
      setMediaItems((prev) => {
        if (next) {
          const have = new Set(prev.map((m) => m.key));
          return [...shopifyExisting.filter((m) => !have.has(m.key)), ...prev];
        }
        return prev.filter((m) => m.kind !== "existing");
      });
      return next;
    });
  }, [shopifyExisting]);

  const genAlt = useCallback(
    async (key: string) => {
      const item = mediaItems.find((m) => m.key === key);
      if (!item) return;
      setMediaBusy(`alt-${key}`);
      try {
        const r = await fetch("/api/openai/image-alt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ imageUrl: item.url }),
        });
        const j = (await r.json().catch(() => ({}))) as { alt?: string; altText?: string };
        const alt = (j.alt || j.altText || "").trim();
        if (alt) setMediaItems((prev) => prev.map((m) => (m.key === key ? { ...m, alt } : m)));
      } catch {
        /* ignore */
      } finally {
        setMediaBusy(null);
      }
    },
    [mediaItems],
  );

  const genAllAlts = useCallback(async () => {
    if (!mediaItems.length) return;
    setMediaBusy("alt-all");
    setErr(null);
    try {
      const results = await Promise.allSettled(
        mediaItems.map(async (m) => {
          const r = await fetch("/api/openai/image-alt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: m.url }),
          });
          const j = (await r.json().catch(() => ({}))) as { alt?: string; altText?: string };
          return { key: m.key, alt: (j.alt || j.altText || "").trim() };
        }),
      );
      const alts = new Map<string, string>();
      for (const res of results) {
        if (res.status === "fulfilled" && res.value.alt) alts.set(res.value.key, res.value.alt);
      }
      setMediaItems((prev) => prev.map((m) => (alts.has(m.key) ? { ...m, alt: alts.get(m.key) as string } : m)));
      setMsg(`Generated alt text for ${alts.size}/${mediaItems.length} image(s).`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Alt generation failed");
    } finally {
      setMediaBusy(null);
    }
  }, [mediaItems]);

  const moveMedia = (key: string, dir: -1 | 1) =>
    setMediaItems((prev) => {
      const i = prev.findIndex((m) => m.key === key);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const copy = [...prev];
      [copy[i], copy[j]] = [copy[j], copy[i]];
      return copy;
    });
  const makeHero = (key: string) =>
    setMediaItems((prev) => {
      const i = prev.findIndex((m) => m.key === key);
      if (i <= 0) return prev;
      const copy = [...prev];
      const [it] = copy.splice(i, 1);
      copy.unshift(it);
      return copy;
    });
  // Drop reorder — moves the whole multi-selection together when the dragged row
  // is selected, otherwise just the dragged row; inserted before the drop target.
  const dropOnMedia = (targetKey: string) =>
    setMediaItems((prev) => {
      if (!mediaDragKey) return prev;
      const movingKeys =
        mediaSel.has(mediaDragKey) && mediaSel.size > 0 ? new Set(mediaSel) : new Set<string>([mediaDragKey]);
      if (movingKeys.has(targetKey)) return prev;
      const moved = prev.filter((m) => movingKeys.has(m.key));
      const rest = prev.filter((m) => !movingKeys.has(m.key));
      const ti = rest.findIndex((m) => m.key === targetKey);
      if (ti < 0 || moved.length === 0) return prev;
      return [...rest.slice(0, ti), ...moved, ...rest.slice(ti)];
    });
  // Drop onto the tail zone → move the dragged row(s) to the very end. (The
  // per-row drop always inserts BEFORE a row, so it can never reach the bottom.)
  const dropAtEnd = () =>
    setMediaItems((prev) => {
      if (!mediaDragKey) return prev;
      const movingKeys =
        mediaSel.has(mediaDragKey) && mediaSel.size > 0 ? new Set(mediaSel) : new Set<string>([mediaDragKey]);
      const moved = prev.filter((m) => movingKeys.has(m.key));
      if (moved.length === 0) return prev;
      const rest = prev.filter((m) => !movingKeys.has(m.key));
      return [...rest, ...moved];
    });
  const removeMedia = (key: string) => setMediaItems((prev) => prev.filter((m) => m.key !== key));

  const publishMedia = useCallback(async () => {
    setMediaBusy("publish");
    setErr(null);
    setMsg(null);
    try {
      // Main-pic assignment: with ONE colour the hero (index 0) is that colour's
      // main pic BY DEFAULT, unless the operator explicitly picked another image
      // (then only that image is); with MULTIPLE colours the operator assigns one
      // image per colour (default none). Only images with a colour push as the
      // variant main pic.
      const single = colorOpts.length === 1 ? colorOpts[0] : null;
      const overridden = single ? mediaItems.some((x) => x.color) : false;
      const items = mediaItems.map((m, idx) => {
        const colorName = single ? (overridden ? m.color : idx === 0 ? single.color : "") : m.color;
        const variantIds = colorName ? colorOpts.find((o) => o.color === colorName)?.variantIds : undefined;
        return m.kind === "existing"
          ? { kind: "existing", mediaId: m.mediaId, alt: m.alt, variantIds }
          : { kind: "new", b64: m.b64, alt: m.alt, variantIds };
      });
      const r = await fetch("/api/shopify/media", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The model these images were generated with: the server records it on
        // the matrix and pushes the hidden "Model is … and wears size …" line.
        body: JSON.stringify({ matrixId, items, studioModelName: model?.name ?? "" }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        media?: Array<{ id: string; url: string; alt: string }>;
        warnings?: string[];
      };
      if (!r.ok) throw new Error(j.error ?? "Publish failed");
      const newCount = mediaItems.filter((m) => m.kind === "new").length;
      setMediaItems(
        (j.media || []).map((m) => ({ key: `ex-${m.id}`, kind: "existing", mediaId: m.id, url: m.url, alt: m.alt || "", color: "" })),
      );
      setMediaSel(new Set());
      // Tell the matrix window (and through it the catalog grid) to revalidate —
      // gallery, per-colour images and thumbnails changed on the server.
      window.dispatchEvent(new CustomEvent("wms:media-published", { detail: { matrixId } }));
      // Distinguish images that FAILED to push (stage/create) from benign notes
      // (reorder/writeback). Keep the source crops on any failure so the operator
      // can retry the affected ones instead of losing them.
      const allWarn = j.warnings ?? [];
      const hardFails = allWarn.filter((w) => /^(stage|create)/.test(w));
      if (hardFails.length) {
        setMsg(null);
        setErr(`${hardFails.length} image(s) could not be pushed: ${hardFails.slice(0, 2).join(" · ")}`);
      } else {
        setCrops((prev) => prev.filter((c) => !c.selected));
        const note = allWarn.length ? ` · note: ${allWarn.slice(0, 2).join(" · ")}` : "";
        setErr(null);
        setMsg(`Saved to Shopify — ${(j.media || []).length} image(s) live${newCount ? `, ${newCount} new` : ""}${note}.`);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Publish failed");
    } finally {
      setMediaBusy(null);
    }
  }, [matrixId, mediaItems, colorOpts, model?.name]);

  /* ── Bulk Studio hooks ─────────────────────────────────────────────────────
     The page drives many products at once; each one still runs THIS code, so
     Analyze is the same analysis and Send queues the same panel requests. */
  const bulkAnalyze = useCallback(async (): Promise<boolean> => {
    if (!specStale) return true;
    if (!productRefCount || busy !== null || specBusy || prepping > 0) return false;
    setErr(null);
    setClock({ startedAt: Date.now(), endedAt: null });
    setProgress("Analyzing item details…");
    try {
      return (await analyzeItem(refViews)) !== null;
    } finally {
      setProgress("");
      setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
    }
  }, [specStale, productRefCount, busy, specBusy, prepping, analyzeItem, refViews]);
  const bulkQueue = useCallback(async (): Promise<boolean> => {
    if (busy !== null) return false;
    batchQueuedRef.current = null;
    setClock({ startedAt: Date.now(), endedAt: null });
    await generate("batch");
    setClock((c) => (c && c.endedAt === null ? { ...c, endedAt: Date.now() } : c));
    return batchQueuedRef.current !== null;
  }, [busy, generate]);
  const bulkApiRef = useRef<BulkStudioApi>({ analyze: async () => false, queue: async () => false, refreshBatch: async () => {} });
  bulkApiRef.current = { analyze: bulkAnalyze, queue: bulkQueue, refreshBatch };
  const bulkRegister = bulk?.register;
  useEffect(() => {
    if (!bulkRegister) return;
    bulkRegister({
      analyze: () => bulkApiRef.current.analyze(),
      queue: () => bulkApiRef.current.queue(),
      refreshBatch: () => bulkApiRef.current.refreshBatch(),
    });
    return () => bulkRegister(null);
  }, [bulkRegister]);
  const bulkStatus = useMemo((): BulkStudioStatus | null => {
    if (!bulk) return null;
    const analyzeProblems: string[] = [];
    if (!stateLoaded) analyzeProblems.push("Loading this product's saved Studio…");
    if (!productRefCount) analyzeProblems.push("Add a Front, Back or Accessories photo.");
    if (prepping > 0) analyzeProblems.push("Photos are still being sorted…");
    const sendProblems = [...analyzeProblems];
    if (!model) sendProblems.push("Choose a model.");
    if (refViews.styling.length > MAX_STYLING_REFS) sendProblems.push(`Style with holds up to ${MAX_STYLING_REFS} photos.`);
    if (specStale) sendProblems.push(itemSpec.trim() ? "Photos changed since the analysis — Analyze again." : "Analyze first.");
    if (model && !accessoryKind) {
      const backFacing = PANELS.some((p) => getPanelPosePair(model.gender, p).some((pose) => isBackFacingPose(model.gender, pose)));
      const backKnown = refViews.back.length > 0 || backIsPlain || specSaysBackDesign || specBack === "plain";
      if (backFacing && !backKnown) sendProblems.push('The back is unknown — add a Back photo or tick "The back is plain".');
    }
    if (!specStale && specBlocked) sendProblems.push('The spec has red lines — fix them or tick "I checked the spec".');
    if (isJeansType && !accessoryKind && !jeansLabelId && specHasBackWaistbandLabel(itemSpec)) {
      sendProblems.push("Pick this product's jeans label.");
    }
    const live = batchItems.filter((b) => b.status !== "cancelled");
    const latest = live[0] ?? null;
    return {
      matrixId,
      modelName: model?.name ?? null,
      photoCount: itemRefs.length,
      spec: !itemSpec.trim() ? "none" : specStale ? "stale" : "ready",
      busy: busy !== null || specBusy || prepping > 0,
      analyzeProblems,
      sendProblems,
      batchOpen: live.filter((b) => b.status === "queued" || b.status === "preparing" || b.status === "submitted").length,
      batchReady: live.filter((b) => b.status === "ready").length,
      batchLine: latest ? `${latest.modelName ?? "Model"}${latest.itemColour ? ` · ${latest.itemColour}` : ""} — ${batchStatusText(latest)}` : null,
      clockText,
      error: err,
      message: progress || msg,
    };
  }, [bulk, stateLoaded, prepping, productRefCount, model, refViews, specStale, itemSpec, accessoryKind, backIsPlain, specSaysBackDesign, specBack, specBlocked, isJeansType, jeansLabelId, batchItems, matrixId, itemRefs.length, busy, specBusy, clockText, err, progress, msg]);
  const bulkOnStatus = bulk?.onStatus;
  const bulkStatusKey = bulkStatus ? JSON.stringify(bulkStatus) : "";
  useEffect(() => {
    if (bulkOnStatus && bulkStatus) bulkOnStatus(bulkStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report only when the content changes
  }, [bulkOnStatus, bulkStatusKey]);

  const label = "block text-[0.74rem] uppercase tracking-wide text-[var(--wms-muted)] mb-1";
  const field =
    "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1.5 font-mono text-[0.85rem] text-[var(--wms-fg)]";
  // One colour → the hero is auto-assigned as its main pic; many colours → the
  // operator picks one image per colour (each pick locks that colour out of the rest).
  const singleColor = colorOpts.length === 1 ? colorOpts[0] : null;
  /** The Colourway box sits beside Style with (md+), stacked on phones. */
  const showColourway = !bulk && canManage && colors.length > 0 && !!color;

  /* Blocks Bulk Studio places inside the photo grid (beside Style with); the
     Studio tab keeps them where they always were. */
  const labelBlock = (
    <>
      {/* Jeans label — only for JEANS / DENIM SHORTS. The library is shared by
          every product; the pick is this product's. Pose 7 leaves a placeholder
          and the server pastes the cropped photo into it; Pose 4 always keeps
          the shirt over the waistband (owner's hard lock). */}
      {canManage && isJeansType ? (
        <LabelDrawer
          bulk={Boolean(bulk)}
          summary={`Jeans label${chosenLabel ? ` · ${chosenLabel.name || "picked"}` : " · none picked"}`}
          defaultOpen={!jeansLabelId}
        >
        <div
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3"
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = imageFilesFromTransfer(e.dataTransfer);
            if (!files.length) return;
            e.preventDefault();
            e.stopPropagation();
            void uploadLabelPhotos(files);
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`${label} mb-0`}>
              Jeans label{chosenLabel ? <span className="text-[var(--wms-fg)]"> · {chosenLabel.name || "picked"}</span> : null}
            </span>
            <label className="cursor-pointer rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)] max-md:min-h-11 max-md:px-3 max-md:py-2">
              {labelBusy ? "saving…" : "＋ upload label photos"}
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                disabled={labelBusy}
                onChange={(e) => {
                  void uploadLabelPhotos(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {!bulk ? (
            <p className="mt-1 text-[0.72rem] text-[var(--wms-muted)]">
              Pick the patch sewn on the back of this product&apos;s waistband. Its photo is sent to the AI with Pose 7 (the
              zoomed-in back) with the command to put exactly this label on the back waistband; the shirt rests on the top edge
              of the waistband — no skin. Pose 4 (the full-body back) always keeps the shirt over the jeans, so no label shows
              there. Upload every label once — they are kept for all products.
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={labelBusy}
              onClick={() => {
                handoffTargetRef.current = "label";
                setLabelPhoneOpen(true);
                void startPhoneCamera();
              }}
              title="Phone camera (QR) — every photo goes into the jeans-label library"
              className="rounded border border-dashed border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50 max-md:min-h-11 max-md:px-3"
            >
              📱 phone camera
            </button>
            {labelPhoneOpen && qr ? (
              <span className="font-mono text-[0.72rem] text-[var(--wms-status-warning-fg)]">
                Scan the QR code in the photo area above — every photo the phone sends now goes into this label library. Press Done there when finished.
              </span>
            ) : null}
          </div>
          {!jeansLabelId && specHasBackWaistbandLabel(itemSpec) ? (
            <p className="mt-2 rounded border border-[var(--wms-status-warning-fg)]/50 bg-[var(--wms-status-warning-fg)]/10 px-2 py-1.5 text-[0.75rem] font-semibold text-[var(--wms-status-warning-fg)]">
              No label picked for this product — Pose 7 will draw a label of its own. Pick this product&apos;s label below.
            </p>
          ) : null}
          {jeansLabelId && !specHasBackWaistbandLabel(itemSpec) ? (
            <p className="mt-1 text-[0.72rem] text-[var(--wms-status-warning-fg)]">
              The item spec has no label on the back waistband, so the label is not attached. Add a LABEL/PATCH line for the
              back waistband if this product has one.
            </p>
          ) : null}
          {jeansLabels.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setJeansLabelId(null)}
                className={`flex h-20 w-20 items-center justify-center rounded border font-mono text-[0.68rem] ${
                  !jeansLabelId ? "border-[var(--wms-accent)] text-[var(--wms-fg)]" : "border-[var(--wms-border)] text-[var(--wms-muted)]"
                }`}
              >
                none
              </button>
              {jeansLabels.map((l) => (
                <div key={l.id} className="relative">
                  <button
                    type="button"
                    title={l.name || "label"}
                    onClick={() => setJeansLabelId(l.id)}
                    className={`block h-20 w-20 overflow-hidden rounded border-2 ${
                      jeansLabelId === l.id ? "border-[var(--wms-accent)]" : "border-[var(--wms-border)]"
                    }`}
                  >
                    <img src={previewFor(l.url)} alt={l.name || "jeans label"} className="h-full w-full object-cover" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${l.name || "label"} from the library`}
                    disabled={labelBusy}
                    onClick={() => void removeLabel(l)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--wms-status-danger-fg)]/60 bg-[var(--wms-surface)] text-[0.7rem] leading-none text-[var(--wms-status-danger-fg)] max-md:h-7 max-md:w-7"
                  >
                    ×
                  </button>
                  <span className="mt-0.5 block w-20 truncate text-center font-mono text-[0.62rem] text-[var(--wms-muted)]">{l.name}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 font-mono text-[0.72rem] text-[var(--wms-muted)]">
              No label photos yet — upload or drop photos of your back-waistband labels here.
            </p>
          )}
        </div>
        </LabelDrawer>
      ) : null}
    </>
  );
  const specBlock = (
    <>
      {/* Item spec — what the render is locked to. Visible and editable:
          a wrong line here is a wrong garment in every paid panel. */}
      <div
        className={`rounded-md border p-3 ${
          productRefCount && specStale
            ? "border-amber-500/55 bg-amber-950/20"
            : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40"
        }`}
      >
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className={`${label} mb-0`}>Item spec — what the AI is locked to</span>
          <span
            className={`font-mono text-[0.62rem] uppercase tracking-wide ${
              !productRefCount
                ? "text-[var(--wms-muted)]"
                : specStale
                  ? "text-amber-300"
                  : "text-[var(--wms-status-success-fg)]"
            }`}
          >
            {!productRefCount
              ? "add photos first"
              : !itemSpec.trim()
                ? "not analyzed yet"
                : specStale
                  ? "photos changed — re-analyze"
                  : `ready · ${itemSpec.split("\n").filter(Boolean).length} lines`}
          </span>
          <div className="flex-1" />
          <button
            type="button"
            disabled={!canManage || !productRefCount || specBusy || busy !== null}
            onClick={() => void analyzeItem(refViews)}
            className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-3 py-1 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50 max-md:min-h-11"
          >
            {specBusy ? "Analyzing…" : itemSpec.trim() ? "↻ Re-analyze photos" : "🔍 Analyze photos"}
          </button>
        </div>
        <p className="mb-2 font-mono text-[0.66rem] leading-snug text-[var(--wms-muted)]">
          Every line below is enforced on the render. Read it before generating and fix anything wrong —
          fit, colour, where each print sits, and the <b>BACK</b> line. Your edits are kept for this product
          and used as-is; only <b>Re-analyze</b> replaces them.
        </p>
        <textarea
          className={`${field} min-h-[7rem] max-md:text-base`}
          rows={itemSpec.trim() ? Math.min(14, Math.max(5, itemSpec.split("\n").length + 1)) : 3}
          placeholder="Press Analyze photos (or Generate) — the numbered spec of the garment appears here. You can also type one."
          value={itemSpec}
          disabled={!canManage}
          onChange={(e) => {
            setItemSpec(e.target.value);
            // A human edit covers the photos on screen: Generate must not
            // re-analyze and throw the correction away, and a spec typed
            // after a failed analysis must be usable.
            setSpecRefsKey(refsKey);
            setSpecConfirmed(true);
          }}
        />
        {/* The lines most likely to be wrong — checked before anything is paid for. */}
        {specRisk.blocking.length || specRisk.warnings.length ? (
          <div className="mt-2 space-y-1">
            {specRisk.blocking.map((x, i) => (
              <p key={`b${i}`} className="font-mono text-[0.72rem] leading-snug text-[var(--wms-status-danger-fg)]">
                ✕ {x.message}
              </p>
            ))}
            {specRisk.warnings.map((x, i) => (
              <p key={`w${i}`} className="font-mono text-[0.72rem] leading-snug text-[var(--wms-status-warning-fg)]">
                ⚠ {x.message}
              </p>
            ))}
            {specRisk.blocking.length ? (
              <label className="flex cursor-pointer items-center gap-2 font-mono text-[0.72rem] text-[var(--wms-fg)] max-md:min-h-11">
                <input
                  type="checkbox"
                  className="max-md:h-5 max-md:w-5"
                  checked={specConfirmed}
                  disabled={!canManage}
                  onChange={(e) => setSpecConfirmed(e.target.checked)}
                />
                I checked the spec against the real garment — it is right
              </label>
            ) : null}
          </div>
        ) : null}
      </div>

    </>
  );
  const optionsBlock = (
    <>
      {/* Options */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div>
          <span className={label}>
            Model{itemGender ? <span className="text-[var(--wms-muted)]"> · {itemGender} only</span> : null}
          </span>
          <select ref={modelSelectRef} className={field} value={modelId} onChange={(e) => setModelId(e.target.value)}>
            {visibleModels.length === 0 ? (
              <option value="">{models.length ? `No ${itemGender ?? ""} models` : "No models"}</option>
            ) : null}
            {visibleModels.map((m) => (
              <option key={m.model_id} value={m.model_id}>
                {m.name} ({m.gender})
              </option>
            ))}
          </select>
        </div>
        <div>
          <span className={label}>{accessoryKind ? "Accessory type" : "Item type"}</span>
          {accessoryKind ? (
            /* Accessory mode picks its shot list and outfit from this, so it is a
               choice, not free text: a typo would quietly fall back to the
               generic shots. */
            <select
              className={`${field} max-md:text-base`}
              value={ACCESSORY_TYPE_OPTIONS.includes(itemType.trim().toUpperCase()) ? itemType.trim().toUpperCase() : ""}
              onChange={(e) => setItemType(e.target.value)}
            >
              <option value="">{itemType.trim() ? `${itemType.trim()} — choose a type` : "Choose a type"}</option>
              {ACCESSORY_TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          ) : (
            <input className={field} value={itemType} onChange={(e) => setItemType(e.target.value)} />
          )}
        </div>
        <div>
          <span className={label}>Colour</span>
          <select className={field} value={color} onChange={(e) => setColor(e.target.value)}>
            {colors.map((c) => (
              <option key={c.color} value={c.color}>
                {c.color}
              </option>
            ))}
          </select>
        </div>
      </div>


      <div>
        <span className={label}>Item instruction (optional)</span>
        <input
          className={field}
          placeholder="e.g. oversized cut, super skinny fit, high-waist…"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
      </div>

    </>
  );

  return (
    <div className="space-y-3">
      {/* Item photos — three sections: General (exactly the old box), Front, Back */}
      <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 p-3">
        {!bulk ? (
          <>
            <span className={label}>Item photo(s) — the garment reference</span>
            <p className="mb-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
              Sort the photos by view so the front and the back can never be mixed up. Drag &amp; drop into a section,
              paste from clipboard (⌘/Ctrl+V — lands in the highlighted section), upload, or use the phone camera.
            </p>
          </>
        ) : null}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = e.target.files ? Array.from(e.target.files) : [];
            if (files.length && bulkIngestRef.current) bulkIngestRef.current(files.map((file) => ({ file })));
            else if (files.length) void uploadItems(files, uploadViewRef.current);
            e.target.value = "";
          }}
        />
        {recoverCount > 0 ? (
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/55 bg-amber-950/25 px-3 py-2 font-mono text-[0.72rem] text-amber-200">
            <span>
              📱 {recoverCount} photo{recoverCount === 1 ? "" : "s"} sent from a phone for this product{" "}
              {recoverCount === 1 ? "was" : "were"} never collected.
            </span>
            <button
              type="button"
              disabled={!canManage || recoverBusy}
              onClick={() => void recoverHandoff()}
              className="rounded border border-amber-400/70 bg-amber-400/15 px-2 py-1 text-amber-100 disabled:opacity-50 max-md:min-h-11"
            >
              {recoverBusy ? "Adding…" : `＋ Add ${recoverCount === 1 ? "it" : "them"} to ${REF_VIEWS.find((z) => z.view === activeView)?.title ?? "General"}`}
            </button>
          </div>
        ) : null}
        <div ref={photosRef} className="grid gap-2 md:grid-cols-3">
          {(() => {
          /* Bulk Studio: Style with lives inside the Accessories · General box
             (owner 2026-10-20) — still its own kind of photo (worn with the item,
             never analyzed), drawn as a nested section of that box. */
          const renderZone = (zone: (typeof REF_VIEWS)[number], nested = false): ReactNode => {
            /* Bulk: one box holds General and Style with (each photo keeps its own kind). */
            const zoneRefs = itemRefs.filter((r) =>
              bulk && zone.view === "general" ? (r.view ?? "general") === "general" || r.view === "styling" : (r.view ?? "general") === zone.view,
            );
            const isActive = activeView === zone.view;
            const isOver = dragOverView === zone.view;
            return (
              <Fragment key={zone.view}>
              <div
                // Hit target for the touch drag (document.elementFromPoint).
                data-ref-zone={zone.view}
                onClick={(e) => {
                  if (nested) e.stopPropagation();
                  selectView(zone.view);
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (nested) e.stopPropagation();
                  if (canManage) setDragOverView(zone.view);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  setDragOverView((v) => (v === zone.view ? null : v));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (nested) e.stopPropagation();
                  setDragOverView(null);
                  if (!canManage) return;
                  selectView(zone.view);
                  // A photo dragged from another section is ADDED here and
                  // stays where it was — one picture can legitimately be the
                  // general shot and the front shot at once.
                  const dragged = e.dataTransfer.getData(REF_DRAG_TYPE);
                  if (dragged) {
                    try {
                      const payload = JSON.parse(dragged) as { url: string; view?: RefView };
                      if (payload?.url) copyRefToView(payload.url, zone.view);
                    } catch {
                      /* not our payload — ignore */
                    }
                    return;
                  }
                  const imgs = imageFilesFromTransfer(e.dataTransfer);
                  if (imgs.length) void uploadItems(imgs, zone.view);
                }}
                className={`rounded-md border p-2 transition-colors ${zone.view === "styling" && !bulk ? (showColourway ? "md:col-span-2" : "md:col-span-3") : ""} ${
                  isOver
                    ? "border-2 border-dashed border-[var(--wms-accent)] bg-[var(--wms-accent)]/10"
                    : isActive
                      ? "border-[var(--wms-accent)]/60 bg-[var(--wms-surface)]"
                      : "border-[var(--wms-border)] bg-[var(--wms-surface)]/60"
                }`}
              >
                <div className="mb-1 flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[0.72rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">
                    {bulk && zone.view === "general" ? "Accessories · General · Style with" : zone.title}
                    {zoneRefs.length ? ` · ${zoneRefs.length}` : ""}
                  </span>
                  {isActive ? (
                    <span className="font-mono text-[0.6rem] uppercase tracking-wide text-[var(--wms-accent)]">
                      {bulk ? "camera target" : "paste / camera target"}
                    </span>
                  ) : null}
                </div>
                {bulk && zone.view === "styling" ? null : (
                  <p className="mb-2 font-mono text-[0.64rem] leading-snug text-[var(--wms-muted)]">
                    {bulk && zone.view === "general" ? "Accessories, flats, any view — works exactly as before." : zone.hint}
                  </p>
                )}
                {zone.view === "back" && !(bulk && zoneRefs.length > 0) ? (
                  /* The alternative to a back photo: the operator's word,
                     (Bulk Studio: hidden once a back photo is in; short label, no warning.)
                     after looking at the garment. Required before any
                     back-facing pose renders. */
                  <label
                    className="mb-2 flex cursor-pointer items-start gap-1.5 font-mono text-[0.66rem] leading-snug text-[var(--wms-fg)] max-md:py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                      checked={backIsPlain}
                      disabled={!canManage}
                      onChange={(e) => setBackIsPlain(e.target.checked)}
                    />
                    {bulk ? (
                      <span>
                        The back is <b>plain</b>
                      </span>
                    ) : (
                    <span>
                      The back is <b>plain</b> — no print, text, logo or graphic (I checked the real garment)
                      {backIsPlain && specSaysBackDesign ? (
                        <span className="mt-0.5 block text-amber-300">
                          ⚠ The item spec says the back HAS a design — the spec wins. Untick this, or fix the BACK line in the spec.
                        </span>
                      ) : null}
                    </span>
                    )}
                  </label>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  {zoneRefs.map((ref, i) => (
                    <div
                      key={ref.url + i}
                      className="relative"
                      draggable={canManage}
                      title="Drag onto another section to also label it there (on a phone: press and hold, then drag)"
                      style={touchDrag ? { touchAction: "none" } : undefined}
                      onPointerDown={(e) => {
                        // The mouse keeps the native HTML5 drag; this is for fingers.
                        if (!canManage || e.pointerType === "mouse") return;
                        const el = e.currentTarget;
                        const p = {
                          url: ref.url,
                          preview: ref.preview,
                          from: zone.view,
                          pointerId: e.pointerId,
                          startX: e.clientX,
                          startY: e.clientY,
                          timer: null as ReturnType<typeof setTimeout> | null,
                          active: false,
                        };
                        touchDragRef.current = p;
                        p.timer = setTimeout(() => {
                          if (touchDragRef.current !== p) return;
                          p.active = true;
                          // Capture, or the moves stop arriving the moment the
                          // finger leaves this thumbnail.
                          try {
                            el.setPointerCapture(p.pointerId);
                          } catch {
                            /* capture unsupported — the drag still tracks while over the tray */
                          }
                          setTouchDrag({ preview: p.preview, x: p.startX, y: p.startY });
                          setHoverView(zone.view);
                          try {
                            navigator.vibrate?.(15);
                          } catch {
                            /* no haptics — nothing depends on it */
                          }
                        }, 220);
                      }}
                      onPointerMove={(e) => {
                        const p = touchDragRef.current;
                        if (!p || p.pointerId !== e.pointerId) return;
                        if (!p.active) {
                          /* Moved before the hold completed — that is a scroll,
                             not a drag. */
                          if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 12) {
                            if (p.timer) clearTimeout(p.timer);
                            touchDragRef.current = null;
                          }
                          return;
                        }
                        setTouchDrag({ preview: p.preview, x: e.clientX, y: e.clientY });
                        const under = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
                        const target = under?.closest?.("[data-ref-zone]")?.getAttribute("data-ref-zone");
                        setHoverView(isRefView(target) ? target : null);
                      }}
                      onPointerUp={(e) => {
                        const p = touchDragRef.current;
                        if (!p || p.pointerId !== e.pointerId) return;
                        if (p.timer) clearTimeout(p.timer);
                        endTouchDrag(true);
                      }}
                      onPointerCancel={() => {
                        const p = touchDragRef.current;
                        if (p?.timer) clearTimeout(p.timer);
                        endTouchDrag(false);
                      }}
                      onDragStart={(e) => {
                        /* Identify the photo, never carry it. A cropped
                           reference's preview is a multi-megabyte PNG data
                           URL, and a dataTransfer payload that large is
                           silently dropped by the browser — after which the
                           drop read an empty string and nothing happened. The
                           drop looks the photo up in state instead. */
                        e.dataTransfer.setData(
                          REF_DRAG_TYPE,
                          JSON.stringify({ url: ref.url, view: ref.view ?? zone.view }),
                        );
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                    >
                      {ref.preview ? (
                        <img
                          src={ref.preview}
                          alt={`item ref (${zone.title})`}
                          title="Click to view full size"
                          draggable={false}
                          className="h-28 w-24 cursor-zoom-in rounded border border-[var(--wms-border)] object-cover"
                          onClick={(e) => {
                            e.stopPropagation();
                            // A finished touch drag must not also open the viewer.
                            if (Date.now() - suppressClickRef.current < 400) return;
                            setZoomRef(ref);
                            setZoom(ref.preview as string);
                          }}
                        />
                      ) : (
                        <div className="flex h-28 w-24 items-center justify-center rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] text-center font-mono text-[0.62rem] text-[var(--wms-status-success-fg)]">
                          ✓ photo
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Only this copy: the same photo may also be
                          // labelled in another section, which stays.
                          setItemRefs((p) => p.filter((x) => !sameRef(x, { url: ref.url, view: ref.view ?? zone.view })));
                        }}
                        className="absolute -right-1 -top-1 rounded-full bg-[var(--wms-surface)] px-1 text-[0.74rem] text-[var(--wms-status-danger-fg)]"
                      >
                        ✕
                      </button>
                      {canManage && /r2\.cloudflarestorage\.com/i.test(ref.url) ? (
                        <button
                          type="button"
                          title="Rotate 90° clockwise"
                          disabled={rotatingUrl !== null}
                          onClick={(e) => {
                            e.stopPropagation();
                            void rotateRefByHand(ref.url);
                          }}
                          className="absolute -left-1 -top-1 rounded-full bg-[var(--wms-surface)] px-1 text-[0.74rem] text-[var(--wms-fg)] hover:text-[var(--wms-accent)] disabled:opacity-50 max-md:min-h-9 max-md:min-w-9"
                        >
                          {rotatingUrl === ref.url ? "…" : "⟳"}
                        </button>
                      ) : null}
                      {bulk && ref.view === "styling" && zone.view !== "styling" ? (
                        <span className="pointer-events-none absolute inset-x-0 top-5 bg-black/65 py-0.5 text-center font-mono text-[0.55rem] uppercase tracking-wide text-white">
                          Style with
                        </span>
                      ) : null}
                      {ref.preview ? (
                        <button
                          type="button"
                          title="Crop — cut the head out so the face stops competing with your model refs"
                          onClick={(e) => {
                            e.stopPropagation();
                            setCropErr(null);
                            setCropping({ ref, src: ref.preview as string });
                          }}
                          className="absolute inset-x-0 bottom-0 rounded-b border-t border-[var(--wms-border)] bg-[var(--wms-surface)]/90 py-0.5 font-mono text-[0.6rem] text-[var(--wms-fg)] hover:text-[var(--wms-accent)] max-md:py-1.5"
                        >
                          Crop
                        </button>
                      ) : null}
                    </div>
                  ))}
                  {!bulk || zone.view === "general" ? (
                  <>
                  <button
                    type="button"
                    disabled={!canManage || busy === "upload"}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectView(zone.view);
                      uploadViewRef.current = zone.view;
                      const input = fileRef.current;
                      if (!input) return;
                      // Android's Photo Picker hijacks accept="image/*" and opens Google
                      // Photos only. On touch devices drop the filter for this click so
                      // the OS shows the full chooser (Camera / Files / Photos / Drive…);
                      // uploadItems still keeps only image/* files. Desktop keeps the
                      // image filter in its file dialog. Behaviour-only (handler), no
                      // render branching.
                      const touch = window.matchMedia("(pointer: coarse)").matches;
                      if (touch) input.removeAttribute("accept");
                      input.click();
                      if (touch) setTimeout(() => input.setAttribute("accept", "image/*"), 0);
                    }}
                    className="rounded-md border border-dashed border-[var(--wms-border)] px-3 py-2 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50"
                  >
                    {busy === "upload" && uploadViewRef.current === zone.view ? "…" : "＋ Upload"}
                  </button>
                  <button
                    type="button"
                    disabled={!canManage}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectView(zone.view);
                      handoffTargetRef.current = "refs";
                      setLabelPhoneOpen(false);
                      void startPhoneCamera();
                    }}
                    title={`Phone camera (QR) — photos land in ${zone.title}`}
                    className="rounded-md border border-dashed border-[var(--wms-border)] px-3 py-2 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50"
                  >
                    📱 Phone camera
                  </button>
                  </>
                  ) : null}
                  {zone.view === "general" && catalogPhotosLeft.length ? (
                    /* Explicit, never automatic: the catalog images are usually
                       the previous renders. Only real product photos belong here. */
                    <button
                      type="button"
                      disabled={!canManage}
                      title="The product's current catalog images — usually earlier renders. Add them only if they are real photos of the garment."
                      onClick={(e) => {
                        e.stopPropagation();
                        setItemRefs((prev) => [
                          ...prev,
                          ...catalogPhotosLeft.map((u): ItemRef => ({ url: u, preview: u, view: "general" })),
                        ]);
                      }}
                      className="rounded-md border border-dashed border-[var(--wms-border)] px-3 py-2 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-muted)] hover:text-[var(--wms-accent)] disabled:opacity-50 max-md:min-h-11"
                    >
                      ＋ Catalog images ({catalogPhotosLeft.length})
                    </button>
                  ) : null}
                </div>
              </div>
              {bulk && zone.view === "back" && !nested ? (
                <div className="space-y-2 md:col-span-3">
                  {optionsBlock}
                  {labelBlock}
                </div>
              ) : null}
              </Fragment>
            );
          };
          return (bulk ? REF_VIEWS.filter((z) => z.view !== "styling") : REF_VIEWS).map((z) => renderZone(z));
          })()}
          {/* Another colourway: same product, same analysis, one photo of the new
              colour. Only rendered when the catalogue actually has colours. */}
          {showColourway ? (
            <div
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3"
              /* Its own drop target: a colour photo dropped here must not make the
                 browser open the file instead. */
              onDragOver={(e) => {
                if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
              }}
              onDrop={(e) => {
                const files = imageFilesFromTransfer(e.dataTransfer);
                if (!files.length) return;
                e.preventDefault();
                e.stopPropagation();
                void uploadColorPhoto(files[0]);
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`${label} mb-0`}>
                  Colourway · <span className="text-[var(--wms-fg)]">{color}</span>
                </span>
                {colorRun?.colorRefUrl ? (
                  <button
                    type="button"
                    onClick={() => void clearColorRun()}
                    disabled={colorBusy}
                    className="rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] text-[var(--wms-muted)] hover:text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11 max-md:px-3"
                  >
                    remove colour photo
                  </button>
                ) : null}
              </div>

              {colorRun?.colorRefUrl ? (
                <div className="mt-2 flex flex-wrap items-start gap-3">
                  <img
                    src={previewFor(colorRun.colorRefUrl)}
                    alt={`${color} colour reference`}
                    className="h-20 w-20 shrink-0 rounded border border-[var(--wms-border)] object-cover"
                  />
                  <div className="min-w-[14rem] flex-1">
                    <span className={label}>Colour the render must hit</span>
                    <input
                      className={`${field} max-md:text-base`}
                      value={colorRun.colorName}
                      placeholder="e.g. deep navy blue"
                      onChange={(e) =>
                        setColorRuns((prev) => ({ ...prev, [color]: { ...prev[color], colorName: e.target.value } }))
                      }
                      onBlur={(e) => {
                        void fetch("/api/studio/color-run", {
                          method: "PUT",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            matrixId,
                            color,
                            colorRefUrl: colorRun.colorRefUrl,
                            colorName: e.target.value,
                            hardwareNote: colorRun.hardwareNote,
                          }),
                        }).catch(() => {});
                      }}
                    />
                    <p className="mt-1 text-[0.72rem] text-[var(--wms-muted)]">
                      Read off the photo. A phone photo carries its lighting, so correct this if the shade looks wrong —
                      the words are what the render follows.
                    </p>
                    {colorRun.hardwareNote ? (
                      <p className="mt-1 text-[0.72rem] text-[var(--wms-status-warning-fg)]">
                        Colour check: {colorRun.hardwareNote}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <p className="mt-1 text-[0.78rem] text-[var(--wms-fg)]">
                  Add one photo of this colour to render the same product in it. The item photos and the analysis above are
                  reused unchanged — only the cloth colour changes, and the poses and expressions are rotated so the set
                  does not look like the other colour with a filter on it.
                </p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="cursor-pointer rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)] max-md:min-h-11 max-md:px-3 max-md:py-2">
                  {colorRun?.colorRefUrl ? "replace photo" : "upload colour photo"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      void uploadColorPhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    handoffTargetRef.current = "colour";
                    setLabelPhoneOpen(false);
                    void startPhoneCamera();
                  }}
                  className="rounded border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] text-[var(--wms-fg)] hover:border-[var(--wms-accent)] max-md:min-h-11 max-md:px-3 max-md:py-2"
                >
                  phone camera
                </button>
                {colorBusy ? <span className="font-mono text-[0.72rem] text-[var(--wms-accent)]">reading colour…</span> : null}
              </div>
            </div>
          ) : null}
        </div>
        {qr ? (
          <div className="mt-3 flex items-center gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
            <img src={qr.url} alt="Scan with your phone" className="h-32 w-32 rounded bg-white p-1" />
            <div className="font-mono text-[0.74rem] text-[var(--wms-muted)]">
              Scan with your phone to take product photos. Each photo the phone sends appears above
              within a few seconds. <b>Keep this open until the phone says every photo was sent</b>, then
              click Done.
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={qrBusy}
                  onClick={() => void finishPhoneCamera()}
                  className="rounded border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-2 py-1 text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11"
                >
                  {qrBusy ? "Collecting…" : "✓ Done"}
                </button>
                <button
                  type="button"
                  disabled={qrBusy}
                  title="Ask the server for every photo this session received — for anything that did not appear"
                  onClick={() =>
                    void collectHandoff(qr.sessionId, true).then((res) => {
                      if (res.status === "gone") setErr("That phone session has expired — scan a new code.");
                      else if (res.status === "error") setErr("Could not reach the server — try again.");
                      else if (!res.added) setMsg("Nothing new from the phone yet.");
                    })
                  }
                  className="rounded border border-[var(--wms-border)] px-2 py-1 text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11"
                >
                  ↻ Check again
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {!bulk ? labelBlock : null}

      {/* Bulk Studio: the spec works in the background — the page's Analyze button shows whether it passed. */}
      {!bulk ? specBlock : null}

      {!bulk ? optionsBlock : null}

      {bulk ? (
        /* Bulk Studio: the page's Analyze all / Send batch replace the buttons
           below; all four panels are sent, the live-only options do not apply. */
        <div className="flex flex-wrap items-center gap-3">
          {progress ? <span className="font-mono text-[0.74rem] text-[var(--wms-accent)]">{progress}</span> : null}
          {prepping > 0 ? (
            <span className="font-mono text-[0.74rem] text-[var(--wms-accent)]">
              Sorting, straightening and cropping {prepping} photo{prepping === 1 ? "" : "s"}…
            </span>
          ) : null}
          {msg ? <span className="font-mono text-[0.74rem] text-[var(--wms-muted)]">{msg}</span> : null}
          {photoWarn ? <span className="font-mono text-[0.74rem] text-[var(--wms-status-warning-fg)]">{photoWarn}</span> : null}
          {aiRefWarn ? <span className="font-mono text-[0.74rem] text-[var(--wms-status-warning-fg)]">{aiRefWarn}</span> : null}
          {err ? <span className="font-mono text-[0.74rem] text-[var(--wms-status-danger-fg)]">{err}</span> : null}
          {busy === "batch" || specBusy ? (
            <button
              type="button"
              disabled={!canManage || aborting}
              onClick={abortGeneration}
              className="rounded-md border border-[var(--wms-status-danger-fg)]/70 bg-[var(--wms-status-danger-fg)]/10 px-3 py-1 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-status-danger-fg)] disabled:opacity-50 max-md:min-h-11"
            >
              {aborting ? "Aborting…" : "■ Abort"}
            </button>
          ) : null}
        </div>
      ) : (
      <>
      {/* How the four panels are tied together, and what the model wears. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {(
          [
            [
              matchPanel1,
              (v: boolean) => {
                setMatchPanel1(v);
                writePref("wms_studio_match_p1_v2", v);
              },
              "Match panel 1 (consistent, slower)",
              "Off (default): all panels render at once, about 1½ minutes. On: panel 1 renders first and the other panels wait for it and render with it attached — about 3 minutes; if panel 1's check flags it, the others are held before anything is paid for.",
            ],
            [
              keepLook,
              (v: boolean) => {
                setKeepLook(v);
                writePref("wms_studio_keep_look", v);
              },
              "Keep look on re-renders",
              "Re-rendering panels without panel 1 attaches this product's last panel 1 for the same model and colour, so the new crops match the ones you kept.",
            ],
            [
              keepStylingPrints,
              (v: boolean) => {
                setKeepStylingPrints(v);
                writePref("wms_studio_keep_prints_v2", v);
              },
              "Keep prints on styling pieces",
              "On: every styling piece you uploaded is worn exactly as photographed, prints included. Off: a tee or tank worn WITH the product is drawn without its printed text (small lettering can come out garbled).",
            ],
          ] as const
        ).map(([on, set, text, hint]) => (
          <label
            key={text}
            title={hint}
            className="flex cursor-pointer items-center gap-2 font-mono text-[0.74rem] text-[var(--wms-fg)] max-md:min-h-11"
          >
            <input type="checkbox" className="max-md:h-5 max-md:w-5" checked={on} disabled={busy !== null} onChange={(e) => set(e.target.checked)} />
            {text}
          </label>
        ))}
      </div>
      {lookPreview ? (
        <details className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40 px-3 py-2">
          <summary className="cursor-pointer font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-muted)] max-md:min-h-11 max-md:py-2">
            Look for this shoot — the same in every panel
          </summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[0.72rem] leading-snug text-[var(--wms-fg)]">{lookPreview.text}</pre>
          {lookPreview.conflicts.length ? (
            <p className="mt-2 rounded border border-amber-500/55 bg-amber-950/25 px-2 py-1 font-mono text-[0.7rem] text-amber-200">
              {lookPreview.conflicts.join(" ")} Fix the instruction or the Style-with photo before generating.
            </p>
          ) : null}
          {lookPreview.pendingReads.length ? (
            <p className="mt-1 font-mono text-[0.68rem] text-[var(--wms-muted)]">
              Generate first reads {lookPreview.pendingReads.join(" and ")} — the pieces they name replace the matching lines above.
            </p>
          ) : null}
        </details>
      ) : null}

      {/* Panels */}
      <div>
        <span className={label}>Panels / poses (choose one or more)</span>
        <div className="flex flex-wrap gap-2">
          {PANELS.map((p) => (
            <label
              key={p}
              className={`cursor-pointer rounded-md border px-2 py-1 font-mono text-[0.74rem] ${
                panels.includes(p)
                  ? "border-[var(--wms-accent)] bg-[var(--wms-accent)]/15 text-[var(--wms-fg)]"
                  : "border-[var(--wms-border)] text-[var(--wms-muted)]"
              }`}
            >
              <input
                type="checkbox"
                className="mr-1 align-middle"
                checked={panels.includes(p)}
                onChange={() => togglePanel(p)}
              />
              {accessoryKind ? accessoryPanelLabel(p) : model ? getPanelButtonLabel(model.gender, p) : `Panel ${p}`}
            </label>
          ))}
          <button
            type="button"
            onClick={() => setPanels(panels.length === PANELS.length ? [] : [...PANELS])}
            className="rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.74rem] text-[var(--wms-muted)]"
          >
            {panels.length === PANELS.length ? "Clear" : "All"}
          </button>
        </div>
      </div>

      {/* Phone-only pose-plan banner. The Model dropdown auto-picks the NEWEST
          model when the item's gender can't be read from its category, which on
          a small screen goes unnoticed — and the pose pairs AND the Manage &
          publish order both follow the model's gender. Make it unmissable right
          above Generate. Desktop (md+) never renders this. */}
      {model ? (() => {
        const mg = (model.gender || "").toLowerCase();
        const mismatch = itemGender ? mg !== itemGender : true;
        return (
          <div
            className={`rounded-md border px-3 py-2 font-mono text-xs md:hidden ${
              mismatch
                ? "border-amber-500/55 bg-amber-950/30 text-amber-200"
                : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] text-[var(--wms-fg)]"
            }`}
          >
            <div>
              Model: <b>{model.name}</b> ({mg || "?"}) → {mg === "female" ? "FEMALE" : "MALE"} pose plan
              {itemGender && mg !== itemGender ? ` · item is ${itemGender} — check the model` : ""}
              {!itemGender ? " · item gender unknown — auto-picked newest model" : ""}
            </div>
            <div className={mismatch ? "text-amber-200/80" : "text-[var(--wms-muted)]"}>
              {panels.length
                ? panels.map((p) => (accessoryKind ? `P${p}: shot ${accessoryShotPair(p).join("+")}` : `P${p}: pose ${getPanelPosePair(model.gender, p).join("+")}`)).join(" · ")
                : "No panels selected"}
            </div>
            <button
              type="button"
              onClick={() => {
                modelSelectRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
                modelSelectRef.current?.focus();
              }}
              className="mt-1 min-h-9 text-[var(--wms-accent)] underline underline-offset-2"
            >
              Change model
            </button>
          </div>
        );
      })() : null}

      {canManage && isJeansType && !accessoryKind && model && model.gender !== "female" && specHasBackWaistbandLabel(itemSpec) && !chosenLabel ? (
        <p className="font-mono text-[0.72rem] font-semibold text-[var(--wms-status-warning-fg)]">
          ⚠ No jeans label picked for this product — pick it in the Jeans label box or Pose 7 draws a label of its own.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canManage || busy !== null || !model || !orderedRefUrls(refViews).length || !panels.length}
          onClick={() => void generate()}
          className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
        >
          {busy === "generate"
            ? "Generating…"
            : busy === "analyze"
              ? "Analyzing item…"
              : productRefCount && specStale
                ? "1 · Analyze item first"
                : crops.length
                  ? `↻ Regenerate ${panels.length}`
                  : `✦ Generate ${panels.length} panel(s)`}
        </button>
        <button
          type="button"
          disabled={!canManage || busy !== null || !model || !orderedRefUrls(refViews).length || !panels.length}
          onClick={() => void generate("batch")}
          title="Queue exactly this run for tonight's OpenAI batch (sent 1 AM Eastern, half the price). The pictures are saved to Dropbox and come back here for review — nothing is published by itself."
          className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-fg)] hover:border-[var(--wms-accent)]/60 disabled:opacity-50 max-md:min-h-11"
        >
          {busy === "batch" ? "Adding to batch…" : `☾ Add ${panels.length} to tonight's batch`}
        </button>
        {busy === "generate" || busy === "analyze" || busy === "batch" ? (
          <button
            type="button"
            disabled={!canManage || aborting}
            onClick={abortGeneration}
            title="Cancel this run — stops the OpenAI generation for every panel still rendering"
            className="rounded-md border border-[var(--wms-status-danger-fg)]/70 bg-[var(--wms-status-danger-fg)]/10 px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-status-danger-fg)] hover:bg-[var(--wms-status-danger-fg)]/20 disabled:opacity-50 max-md:min-h-11"
          >
            {aborting ? "Aborting…" : "■ Abort"}
          </button>
        ) : null}
        <button
          type="button"
          disabled={!canManage || mediaBusy !== null}
          onClick={() => void openMediaManager()}
          title="Arrange images, set the hero, alt text, delete, and publish to Shopify"
          className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
        >
          {mediaBusy === "load" ? "Loading…" : "🖼 Manage & publish images"}
        </button>
        {clock ? (
          <span
            title={clock.endedAt === null ? "Time since you pressed Generate" : "How long that run took"}
            className={`font-mono text-[0.9rem] font-semibold tabular-nums ${
              clock.endedAt === null ? "text-[var(--wms-accent)]" : "text-[var(--wms-fg)]"
            }`}
          >
            ⏱ {clockText}
            {clock.endedAt === null ? "" : " total"}
          </span>
        ) : null}
        {progress ? <span className="font-mono text-[0.74rem] text-[var(--wms-accent)]">{progress}</span> : null}
        {msg ? <span className="font-mono text-[0.74rem] text-[var(--wms-muted)]">{msg}</span> : null}
        {photoWarn ? <span className="font-mono text-[0.74rem] text-[var(--wms-status-warning-fg)]">{photoWarn}</span> : null}
        {aiRefWarn ? <span className="font-mono text-[0.74rem] text-[var(--wms-status-warning-fg)]">{aiRefWarn}</span> : null}
        {err ? <span className="font-mono text-[0.74rem] text-[var(--wms-status-danger-fg)]">{err}</span> : null}
      </div>
      </>
      )}

      {/* Night batch: this product's runs waiting for 1 AM, out with OpenAI, or back for review. */}
      {canManage && (batchItems.some((b) => b.status !== "cancelled") || (!bulk && ((batchOverview?.queuedRuns ?? 0) > 0 || (batchOverview?.open.length ?? 0) > 0))) ? (
        <div className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="font-mono text-[0.74rem] font-semibold uppercase tracking-wide text-[var(--wms-fg)]">☾ Night batch</p>
            <span className="font-mono text-[0.72rem] text-[var(--wms-muted)]">
              {batchOverview
                ? [
                    batchOverview.queuedRuns
                      ? `${batchOverview.queuedRuns} run${batchOverview.queuedRuns === 1 ? "" : "s"} (${batchOverview.queuedPanels} panels) wait for the 1 AM Eastern send`
                      : "Nothing waiting for tonight",
                    batchOverview.open.length
                      ? `${batchOverview.open.reduce((n, b) => n + b.requestCount, 0)} panel(s) with OpenAI now`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "Loading…"}
            </span>
            {!bulk && batchOverview?.queuedRuns ? (
              confirmBatchSend ? (
                <span className="flex flex-wrap items-center gap-2 font-mono text-[0.72rem] text-[var(--wms-fg)]">
                  Send all {batchOverview.queuedRuns} queued run(s) now, for every product?
                  <button
                    type="button"
                    disabled={batchBusy !== null}
                    onClick={() => void runBatchNow("send")}
                    className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-2 py-1 uppercase tracking-wide disabled:opacity-50 max-md:min-h-11"
                  >
                    Yes, send now
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmBatchSend(false)}
                    className="rounded-md border border-[var(--wms-border)] px-2 py-1 uppercase tracking-wide max-md:min-h-11"
                  >
                    No
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={batchBusy !== null}
                  onClick={() => setConfirmBatchSend(true)}
                  title="Send the queue now instead of waiting for 1 AM — same half price"
                  className="rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] uppercase tracking-wide text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11"
                >
                  {batchBusy === "send" ? "Sending…" : "Send now"}
                </button>
              )
            ) : null}
            {!bulk && batchOverview?.open.length ? (
              <button
                type="button"
                disabled={batchBusy !== null}
                onClick={() => void runBatchNow("check")}
                title="Ask OpenAI now instead of waiting for the next automatic check (every 5 minutes)"
                className="rounded-md border border-[var(--wms-border)] px-2 py-1 font-mono text-[0.72rem] uppercase tracking-wide text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11"
              >
                {batchBusy === "check" ? "Checking…" : "Check now"}
              </button>
            ) : null}
          </div>
          {batchItems.filter((b) => b.status !== "cancelled").length ? (
            <ul className="mt-2 flex flex-col gap-1.5">
              {batchItems
                .filter((b) => b.status !== "cancelled")
                .slice(0, 8)
                .map((b) => (
                  <li key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.72rem] text-[var(--wms-fg)]">
                    <span className="tabular-nums text-[var(--wms-muted)]">{formatBatchTime(b.addedAt)}</span>
                    <span>
                      {b.modelName ?? "Model"}
                      {b.itemColour ? ` · ${b.itemColour}` : ""} · P{b.panels.join(", ")}
                    </span>
                    <span className={batchStatusTone(b.status)}>{batchStatusText(b)}</span>
                    {b.status === "queued" ? (
                      <button
                        type="button"
                        disabled={batchBusy !== null}
                        onClick={() => void removeBatchItem(b)}
                        className="text-[var(--wms-status-danger-fg)] underline underline-offset-2 disabled:opacity-50 max-md:min-h-11"
                      >
                        Remove
                      </button>
                    ) : null}
                    {(b.status === "ready" || b.status === "loaded" || b.status === "published") && b.ready.length ? (
                      <button
                        type="button"
                        disabled={batchBusy !== null || busy !== null}
                        onClick={() => void loadBatchResults(b)}
                        className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-2 py-1 uppercase tracking-wide disabled:opacity-50 max-md:min-h-11"
                      >
                        {batchBusy === b.id ? "Loading…" : b.status === "loaded" ? "Load again" : "Load results"}
                      </button>
                    ) : null}
                    {b.failed.length ? (
                      <span className="basis-full text-[var(--wms-status-danger-fg)]">
                        {b.failed.map((f) => `Panel ${f.panel}: ${f.error}`).join(" · ")}
                      </span>
                    ) : null}
                    {b.error && b.status !== "failed" ? <span className="basis-full text-[var(--wms-status-warning-fg)]">{b.error}</span> : null}
                    {b.folder ? (
                      <span className="basis-full text-[var(--wms-muted)]">
                        In Dropbox: {b.folder.replace(/^\/+/, "").split("/").join(" › ")}
                      </span>
                    ) : null}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Panel 1's check flagged it; the other panels are held, unpaid, until the operator decides. */}
      {heldRun && busy === null ? (
        <div className="rounded-md border border-amber-500/55 bg-amber-950/25 p-3">
          <p className="font-mono text-[0.74rem] text-amber-200">
            Panel 1 was flagged — panel{heldRun.followers.length > 1 ? "s" : ""} {heldRun.followers.join(", ")} {heldRun.followers.length > 1 ? "are" : "is"} on
            hold and nothing was paid for {heldRun.followers.length > 1 ? "them" : "it"}:
          </p>
          <ul className="mt-1 list-disc pl-5 font-mono text-[0.72rem] text-[var(--wms-fg)]">
            {heldRun.findings.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!canManage}
              onClick={() => void forceFollowersRef.current?.()}
              className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11"
            >
              Render the other panels anyway
            </button>
            <button
              type="button"
              disabled={!canManage}
              onClick={() => {
                setHeldRun(null);
                forceFollowersRef.current = null;
                void generate();
              }}
              className="rounded-md border border-[var(--wms-border)] px-3 py-1.5 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-fg)] disabled:opacity-50 max-md:min-h-11"
            >
              ↻ Regenerate panel 1 (the others follow)
            </button>
          </div>
        </div>
      ) : null}

      {!shopifyProductId && !bulk ? (
        <p className="font-mono text-[0.68rem] text-[var(--wms-muted)]">
          Generation &amp; download work here without Shopify. To <b>push</b> images, link this
          product (🔗 Link to Shopify) or ✔ Check &amp; Publish it first.
        </p>
      ) : null}

      {crops.length ? (
        <div className="flex flex-wrap gap-3">
          {crops.map((c) =>
            c.b64 ? (
              <div
                key={c.id}
                className={`relative overflow-hidden rounded-md border ${
                  c.selected
                    ? "border-[var(--wms-accent)] ring-1 ring-[var(--wms-accent)]"
                    : c.qaWarnings?.length
                      ? "border-red-500/70"
                      : "border-[var(--wms-border)]"
                }`}
              >
                <img
                  src={`data:image/png;base64,${c.b64}`}
                  alt={c.label}
                  className="h-48 w-36 cursor-zoom-in object-cover"
                  title="Click to view full size"
                  onClick={() => {
                    setZoomRef(null);
                    setZoom(`data:image/png;base64,${c.b64}`);
                  }}
                />
                <label
                  className="absolute left-1 top-1 flex cursor-pointer items-center rounded bg-black/60 p-1"
                  title={c.selected ? "Selected to keep / publish" : "Not selected"}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={c.selected}
                    onChange={() =>
                      setCrops((prev) => prev.map((x) => (x.id === c.id ? { ...x, selected: !x.selected } : x)))
                    }
                    className="h-5 w-5 cursor-pointer accent-[var(--wms-accent)]"
                  />
                </label>
                <button
                  type="button"
                  title="Download"
                  onClick={(e) => {
                    e.stopPropagation();
                    downloadImage(`data:image/png;base64,${c.b64}`, `carbon-studio-${c.id}.png`);
                  }}
                  className="absolute right-1 top-1 rounded bg-black/60 px-2 py-1 text-lg leading-none text-white hover:bg-black/80"
                >
                  ⬇
                </button>
                <span className="block px-1 py-0.5 text-center font-mono text-[0.68rem] text-[var(--wms-muted)]">
                  {c.label} {c.selected ? "✓" : ""}
                  {c.qaPending ? <span className="ml-1 text-[var(--wms-accent)]" title="Waiting for the rest of the run, then these frames are compared with each other and with the item photos">· checking…</span> : null}
                </span>
                {c.qaWarnings?.length ? (
                  <div
                    className="max-w-36 border-t border-red-500/40 bg-red-950/40 px-1.5 py-1 font-mono text-[0.6rem] leading-snug text-red-200"
                    title={c.qaWarnings.join("\n")}
                  >
                    <span className="font-semibold uppercase tracking-wide">⚠ QA flagged</span>
                    <ul className="mt-0.5 list-disc pl-3">
                      {c.qaWarnings.slice(0, 3).map((w, i) => (
                        <li key={i} className="break-words">
                          {w.length > 110 ? `${w.slice(0, 107)}…` : w}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {c.qaNotes?.length ? (
                  <div
                    className="max-w-36 border-t border-[var(--wms-border)] px-1.5 py-1 font-mono text-[0.58rem] leading-snug text-[var(--wms-muted)]"
                    title={c.qaNotes.join("\n")}
                  >
                    <span className="uppercase tracking-wide">QA notes:</span>{" "}
                    {c.qaNotes
                      .slice(0, 2)
                      .map((n) => (n.length > 90 ? `${n.slice(0, 87)}…` : n))
                      .join(" · ")}
                  </div>
                ) : null}
              </div>
            ) : (
              <span key={c.id} className="max-w-[240px] font-mono text-[0.68rem] text-[var(--wms-status-danger-fg)]">
                {c.label}
              </span>
            ),
          )}
        </div>
      ) : null}

      {showMedia ? (
        <div className="rounded-md border border-[var(--wms-accent)]/40 bg-[var(--wms-surface-elevated)]/40 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[0.9rem] uppercase tracking-wide text-[var(--wms-fg)]">Manage images</span>
            <div className="flex-1" />
            <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[0.74rem] text-[var(--wms-muted)]">
              <input
                type="checkbox"
                checked={includeShopify}
                onChange={toggleIncludeShopify}
                className="h-4 w-4 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
              />
              include current Shopify pictures
            </label>
            <button
              type="button"
              disabled={!canManage || mediaBusy !== null || mediaItems.length === 0}
              onClick={() => void genAllAlts()}
              title="Generate alt text for every image"
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-2 font-mono text-[0.82rem] uppercase tracking-wide text-[var(--wms-accent)] hover:bg-[var(--wms-surface-elevated)] disabled:opacity-50"
            >
              {mediaBusy === "alt-all" ? "Generating alt…" : "✨ Alt all"}
            </button>
            <button
              type="button"
              disabled={!canManage || mediaBusy !== null}
              onClick={() => void publishMedia()}
              className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-4 py-2 font-mono text-[0.82rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
            >
              {mediaBusy === "publish" ? "Publishing…" : "⤴ Publish to Shopify"}
            </button>
            <button
              type="button"
              onClick={() => setShowMedia(false)}
              className="rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-2 font-mono text-[0.82rem] uppercase tracking-wide text-[var(--wms-fg)]"
            >
              Close
            </button>
          </div>
          {!shopifyProductId ? (
            <p className="mb-2 rounded border border-[var(--wms-table-clean-border)] bg-[var(--wms-table-clean-bg)] p-2 font-mono text-[0.68rem] text-[var(--wms-table-clean-fg)]">
              This product isn&apos;t on Shopify yet — arrange &amp; download here, but to PUSH images
              you must Link it (🔗 Link to Shopify) or ✔ Check &amp; Publish first.
            </p>
          ) : null}
          {mediaItems.length === 0 ? (
            <p className="font-mono text-[0.74rem] text-[var(--wms-muted)]">
              No images yet — generate or upload, then manage here.
            </p>
          ) : (
            <div className="space-y-2">
              {mediaItems.map((m, idx) => (
                <div
                  key={m.key}
                  onDragOver={(e) => { if (mediaDragKey) e.preventDefault(); }}
                  onDrop={() => { dropOnMedia(m.key); setMediaDragKey(null); }}
                  className={`flex items-start gap-3 rounded border bg-[var(--wms-surface)] p-2 max-sm:flex-wrap ${mediaDragKey === m.key || (mediaDragKey && mediaSel.has(mediaDragKey) && mediaSel.has(m.key)) ? "opacity-50" : ""} ${mediaSel.has(m.key) ? "ring-1 ring-[var(--wms-accent)] " : ""}${mediaDragKey && mediaDragKey !== m.key ? "border-dashed border-[var(--wms-accent)]" : "border-[var(--wms-border)]"}`}
                >
                  <input
                    type="checkbox"
                    checked={mediaSel.has(m.key)}
                    onChange={() => toggleMediaSel(m.key)}
                    title="Select for multi-drag (drag any selected row to move them all)"
                    className="mt-1 h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--wms-accent)] max-md:h-5 max-md:w-5"
                  />
                  <div className="relative shrink-0">
                    <img
                      src={m.url}
                      alt={m.alt}
                      className="h-32 w-24 cursor-pointer rounded border border-[var(--wms-border)] object-cover"
                      onClick={() => {
                        setZoomRef(null);
                        setZoom(m.url);
                      }}
                    />
                    {idx === 0 ? (
                      <span className="absolute left-0 top-0 rounded-br bg-[var(--wms-accent)] px-1 text-[0.62rem] font-bold text-[var(--wms-accent-fg)]">
                        HERO
                      </span>
                    ) : null}
                    <span className="absolute bottom-0 right-0 rounded-tl bg-black/60 px-1 text-[0.62rem] text-white">
                      {m.kind === "new" ? "NEW" : "◆"}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <textarea
                      className="w-full rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-2 py-1 font-mono text-[0.74rem] text-[var(--wms-fg)] max-md:text-base"
                      rows={2}
                      placeholder="alt text"
                      value={m.alt}
                      onChange={(e) => {
                        const v = e.target.value;
                        setMediaItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, alt: v } : x)));
                      }}
                    />
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={mediaBusy !== null}
                        onClick={() => void genAlt(m.key)}
                        className="rounded border border-[var(--wms-border)] px-2 py-0.5 font-mono text-[0.68rem] text-[var(--wms-accent)] disabled:opacity-50 max-md:py-2 max-md:px-3"
                      >
                        {mediaBusy === `alt-${m.key}` ? "…" : "✨ Generate alt"}
                      </button>
                      {singleColor ? (
                        /* Hero is the main pic by default; any other image can take
                           it (picking it here moves the assignment off the hero). */
                        (() => {
                          const overridden = mediaItems.some((x) => x.color);
                          const effective = overridden ? m.color : idx === 0 ? singleColor.color : "";
                          return (
                            <>
                              <label className="font-mono text-[0.68rem] text-[var(--wms-muted)]">main pic for {singleColor.color}:</label>
                              <select
                                className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 font-mono text-[0.68rem] text-[var(--wms-fg)] max-md:py-2 max-md:text-base"
                                value={effective}
                                title="Which image is the main (variant) pic for this colour — the hero by default; pick another image to use it instead"
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setMediaItems((prev) =>
                                    prev.map((x) => (x.key === m.key ? { ...x, color: v } : { ...x, color: v ? "" : x.color })),
                                  );
                                }}
                              >
                                <option value="">— not this one —</option>
                                <option value={singleColor.color}>
                                  {effective
                                    ? idx === 0 && !overridden
                                      ? "★ yes · hero (auto)"
                                      : "★ yes · this image"
                                    : `use this image · all ${singleColor.variantIds.length} size${singleColor.variantIds.length === 1 ? "" : "s"}`}
                                </option>
                              </select>
                            </>
                          );
                        })()
                      ) : (
                        <>
                          <label className="font-mono text-[0.68rem] text-[var(--wms-muted)]">main pic for colour:</label>
                          <select
                            className="rounded border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)] px-1.5 py-0.5 font-mono text-[0.68rem] text-[var(--wms-fg)] max-md:py-2 max-md:text-base"
                            value={m.color}
                            title="One image per colour — the chosen colour locks out of the other images"
                            onChange={(e) => {
                              const v = e.target.value;
                              setMediaItems((prev) => prev.map((x) => (x.key === m.key ? { ...x, color: v } : x)));
                            }}
                          >
                            <option value="">— none —</option>
                            {colorOpts
                              .filter((o) => o.color === m.color || !mediaItems.some((x) => x.key !== m.key && x.color === o.color))
                              .map((o) => (
                                <option key={o.color} value={o.color}>
                                  {o.color} · all {o.variantIds.length} size{o.variantIds.length === 1 ? "" : "s"}
                                </option>
                              ))}
                          </select>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1 max-sm:w-full max-sm:flex-row max-sm:flex-wrap">
                    <div draggable onDragStart={() => setMediaDragKey(m.key)} onDragEnd={() => setMediaDragKey(null)} title="Drag to reorder" className="cursor-move select-none rounded border border-[var(--wms-border)] px-2 py-1 text-center text-base text-[var(--wms-muted)] hover:bg-[var(--wms-surface-elevated)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">⠿</div>
                    <button type="button" onClick={() => moveMedia(m.key, -1)} disabled={idx === 0} className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-fg)] disabled:opacity-30 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">↑</button>
                    <button type="button" onClick={() => moveMedia(m.key, 1)} disabled={idx === mediaItems.length - 1} className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-fg)] disabled:opacity-30 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">↓</button>
                    <button type="button" onClick={() => makeHero(m.key)} disabled={idx === 0} title="Make hero" className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-table-clean-fg)] disabled:opacity-30 max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">★</button>
                    <button type="button" onClick={() => downloadImage(m.url, `${m.kind === "new" ? "carbon-studio" : "shopify"}-${idx + 1}.png`)} title="Download" className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-fg)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">⬇</button>
                    <button type="button" onClick={() => removeMedia(m.key)} title="Remove (deletes from Shopify on publish)" className="rounded border border-[var(--wms-border)] px-2 py-1 text-base text-[var(--wms-status-danger-fg)] max-md:flex max-md:min-h-11 max-md:min-w-11 max-md:items-center max-md:justify-center">✕</button>
                  </div>
                </div>
              ))}
              <div
                onDragOver={(e) => { if (mediaDragKey) e.preventDefault(); }}
                onDrop={() => { dropAtEnd(); setMediaDragKey(null); }}
                className={`rounded border border-dashed py-3 text-center font-mono text-[0.68rem] transition-colors ${mediaDragKey ? "border-[var(--wms-accent)] bg-[var(--wms-accent)]/10 text-[var(--wms-accent)]" : "border-transparent text-transparent"}`}
              >
                ⬇ drop here to move to the end
              </div>
            </div>
          )}
          {err ? (
            <p className="mt-2 font-mono text-[0.74rem] text-[var(--wms-status-danger-fg)]">{err}</p>
          ) : msg ? (
            <p className="mt-2 font-mono text-[0.74rem] text-[var(--wms-status-success-fg)]">{msg}</p>
          ) : null}
        </div>
      ) : null}

      {/* What the finger is carrying, and where it will land. */}
      {touchDrag ? (
        <div
          className="pointer-events-none fixed z-[140]"
          style={{ left: touchDrag.x - 32, top: touchDrag.y - 40 }}
          aria-hidden="true"
        >
          {touchDrag.preview ? (
            <img
              src={touchDrag.preview}
              alt=""
              className="h-20 w-16 rounded border-2 border-[var(--wms-accent)] object-cover opacity-90 shadow-lg"
            />
          ) : (
            <div className="h-20 w-16 rounded border-2 border-[var(--wms-accent)] bg-[var(--wms-surface)] opacity-90 shadow-lg" />
          )}
        </div>
      ) : null}

      {cropping ? (
        <ItemRefCropDialog
          src={cropping.src}
          busy={cropBusy}
          error={cropErr}
          onCancel={() => {
            if (cropBusy) return;
            setCropping(null);
            setCropErr(null);
          }}
          onApply={(blob) => void applyCrop(blob)}
        />
      ) : null}

      {zoom ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-6"
          onClick={() => {
            setZoom(null);
            setZoomRef(null);
          }}
        >
          <img src={zoom} alt="Full size" className="max-h-full max-w-full rounded-lg" />
          {zoomRef && canManage ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const ref = zoomRef;
                setZoom(null);
                setZoomRef(null);
                setCropErr(null);
                setCropping({ ref, src: (ref.preview || ref.url) as string });
              }}
              className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-4 py-2 font-mono text-xs text-[var(--wms-fg)] hover:border-[var(--wms-accent)] max-md:min-h-11"
            >
              ✂ Crop this photo
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setZoom(null);
              setZoomRef(null);
            }}
            className="absolute right-4 top-4 rounded-md bg-white/10 px-3 py-1.5 font-mono text-[0.85rem] text-white"
          >
            ✕ Close
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** The jeans-label box: as is in the Studio tab, a fold-out drawer in Bulk Studio. */
function LabelDrawer({
  bulk,
  summary,
  defaultOpen,
  children,
}: {
  bulk: boolean;
  summary: string;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  if (!bulk) return <>{children}</>;
  return (
    <details open={defaultOpen} className="group rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40">
      <summary className="cursor-pointer px-3 py-2 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-fg)] max-md:min-h-11">
        {summary}
      </summary>
      <div className="px-1 pb-1">{children}</div>
    </details>
  );
}
