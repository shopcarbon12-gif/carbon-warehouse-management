/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildMasterPanelPrompt,
  getPanelPosePair,
  getPanelButtonLabel,
  pickExpressionDirective,
  splitPanelToThreeByFour,
} from "@/lib/panelGeneration";

/**
 * Carbon Studio (M2) — the OpenAI V2 generator, product-scoped.
 * Upload the item photo here (drag/file or phone-camera via QR), pick a model +
 * colour, choose one or MORE panels, generate, then push the chosen on-model
 * crops to Shopify per colour through the M2 image pipeline.
 */
type Model = { model_id: string; name: string; gender: string; ref_image_urls: string[] };
type StudioVariant = { id: string; color: string | null; shopify_variant_id?: string | null };
/** qaWarnings = the server's post-generation lock QA found mismatches (text,
 * graphics, fit, identity, background…). The crop is still delivered — flagged
 * and unselected — so the operator sees the render AND the reasons and decides. */
type Crop = { id: string; b64: string; label: string; selected: boolean; qaWarnings?: string[]; qaNotes?: string[] };
/** url = what the generator fetches (may be an auth'd R2 URL); preview = a
 * browser-renderable thumbnail (data URL for uploads, public URL for Shopify). */
type ItemRef = { url: string; preview?: string };
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

/** Pull image files out of a drop or clipboard payload (drag-drop + paste). */
function imageFilesFromTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.items && dt.items.length) {
    for (const it of Array.from(dt.items)) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  if (!out.length && dt.files && dt.files.length) out.push(...Array.from(dt.files));
  return out.filter((f) => f.type.startsWith("image/"));
}

type Props = {
  matrixId: string;
  shopifyProductId: string | null;
  itemRefUrls: string[];
  defaultItemType: string;
  /** Merchandise category (e.g. "WOMEN" / "MEN") — used to filter models by gender. */
  category?: string;
  variants: StudioVariant[];
  canManage: boolean;
};

const PANELS = [1, 2, 3, 4];

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
  qaWarnings?: string[];
  /** Per-frame split of qaWarnings so only the crop that is wrong gets flagged. */
  qaWarningsBySide?: { left?: string[]; right?: string[] };
  /** Cosmetic observations from QA (background, centring…) — never a failure. */
  qaNotes?: string[];
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

type PendingRun = {
  matrixId: string;
  runTag: string;
  gender: string;
  startedAt: number;
  jobs: { panel: number; jobId: string }[];
};

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
async function claimPanelJob(jobId: string, deadline: number): Promise<PanelResponse | null> {
  while (Date.now() < deadline) {
    await sleep(JOB_POLL_INTERVAL_MS);
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

/** We already have the image; drop the server's parked copy. */
function releasePanelJob(jobId: string): void {
  void fetch(`/api/generate/job?id=${encodeURIComponent(jobId)}`, { method: "DELETE" }).catch(() => {});
}

/** One panel response → the two crops the gallery shows (shared by run + resume). */
async function panelResponseToCrops(
  json: PanelResponse | null,
  panel: number,
  poseA: number,
  poseB: number,
  runTag: string,
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
  // QA-flagged renders are delivered but NOT pre-selected: the operator sees the
  // image and the reasons and opts in explicitly.
  const qaWarnings = Array.isArray(json.qaWarnings) && json.qaWarnings.length ? json.qaWarnings : undefined;
  const bySide = json.qaWarningsBySide;
  // Per-frame attribution when the server provides it (a perfect close-up must
  // not wear its neighbour's flag); otherwise both crops share the panel verdict.
  const forSide = (side: "left" | "right"): string[] | undefined => {
    if (!qaWarnings) return undefined;
    const s = bySide?.[side];
    if (bySide && Array.isArray(s)) return s.length ? s : undefined;
    return qaWarnings;
  };
  const leftWarnings = forSide("left");
  const rightWarnings = forSide("right");
  const qaNotes = Array.isArray(json.qaNotes) && json.qaNotes.length ? json.qaNotes : undefined;
  return [
    { id: `p${panel}-l-${runTag}`, b64: left, label: `P${panel} · Pose ${poseA}`, selected: !leftWarnings, qaWarnings: leftWarnings, qaNotes },
    { id: `p${panel}-r-${runTag}`, b64: right, label: `P${panel} · Pose ${poseB}`, selected: !rightWarnings, qaWarnings: rightWarnings, qaNotes },
  ];
}

export function CarbonStudioTab({
  matrixId,
  shopifyProductId,
  itemRefUrls,
  defaultItemType,
  category,
  variants,
  canManage,
}: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState<string>("");
  /** Phone pose-plan banner's "Change model" jumps here. */
  const modelSelectRef = useRef<HTMLSelectElement | null>(null);
  const [itemType, setItemType] = useState<string>(defaultItemType);
  const [instruction, setInstruction] = useState<string>("");
  const [panels, setPanels] = useState<number[]>([...PANELS]);
  const [itemRefs, setItemRefs] = useState<ItemRef[]>(
    (itemRefUrls || []).map((u) => ({ url: u, preview: u })),
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");
  // Pre-generation item analysis (owner requirement): the item reference photos
  // are inspected at high detail — every word, graphic, material, button,
  // stitch — and the findings are locked into the prompt BEFORE rendering.
  // `itemSpec` is operator-editable; `specRefsKey` remembers which refs it was
  // computed for so a changed photo set re-analyzes automatically.
  // Invisible by owner choice: it runs inside Generate; no control, no preview.
  const [itemSpec, setItemSpec] = useState<string>("");
  const [specRefsKey, setSpecRefsKey] = useState<string>("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [crops, setCrops] = useState<Crop[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
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
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

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

  // Poll the phone-camera hand-off while a QR is showing.
  useEffect(() => {
    if (!qr) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`/api/image-handoff/session/${qr.sessionId}`);
        if (!r.ok) return;
        const j = (await r.json().catch(() => ({}))) as {
          ready?: boolean;
          images?: { imageUrl: string; previewUrl?: string }[];
          imageUrl?: string;
          previewUrl?: string;
        };
        // Keep the QR open so the phone can send more; a burst of up to 6 photos
        // all arrive in one tick via `images`.
        if (alive && j.ready) {
          const batch = j.images?.length
            ? j.images.map((im) => ({ url: im.imageUrl, preview: im.previewUrl }))
            : j.imageUrl
              ? [{ url: j.imageUrl, preview: j.previewUrl }]
              : [];
          if (batch.length) {
            setItemRefs((prev) => [...prev, ...batch]);
            setMsg(`Received ${batch.length} photo${batch.length === 1 ? "" : "s"} from phone.`);
          }
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
    const stop = setTimeout(() => setQr(null), 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [qr]);

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

  const uploadItems = useCallback(async (files: File[]) => {
    const list = files.filter((f) => f.type.startsWith("image/"));
    if (!list.length) return;
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
          return { url: j.url as string, preview: dataUrl } as ItemRef;
        }),
      );
      const ok = results
        .filter((x): x is PromiseFulfilledResult<ItemRef> => x.status === "fulfilled")
        .map((x) => x.value);
      if (ok.length) setItemRefs((prev) => [...prev, ...ok]);
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

  // Paste an image from the clipboard (⌘/Ctrl+V) anywhere in Studio → item ref.
  // Guarded to image payloads only, so pasting text into inputs is untouched.
  useEffect(() => {
    if (!canManage) return;
    const onPaste = (e: ClipboardEvent) => {
      const imgs = imageFilesFromTransfer(e.clipboardData);
      if (imgs.length) {
        e.preventDefault();
        void uploadItems(imgs);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [canManage, uploadItems]);

  const startPhoneCamera = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/image-handoff/session", { method: "POST" });
      const j = (await r.json().catch(() => ({}))) as {
        sessionId?: string;
        scanUrl?: string;
        qrCodeUrl?: string;
      };
      if (!r.ok || !j.sessionId || !j.qrCodeUrl) throw new Error("Could not start phone camera.");
      setQr({ url: j.qrCodeUrl, scanUrl: j.scanUrl || "", sessionId: j.sessionId });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Phone camera failed");
    }
  }, []);

  const togglePanel = useCallback((p: number) => {
    setPanels((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p].sort()));
  }, []);

  /** High-detail vision pass over the item reference photos → numbered lock
   *  list (see /api/openai/item-spec). Stores the spec + the refs it covers. */
  const analyzeItem = useCallback(
    async (refUrls: string[]): Promise<string | null> => {
      if (!refUrls.length) {
        setErr("Add at least one item photo before analyzing.");
        return null;
      }
      try {
        const r = await fetch("/api/openai/item-spec", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemRefs: refUrls, itemType }),
        });
        const j = (await r.json().catch(() => ({}))) as { lockText?: string; error?: string; imagesAnalyzed?: number };
        if (!r.ok || !j.lockText) throw new Error(j.error ?? "Item analysis failed");
        setItemSpec(j.lockText);
        setSpecRefsKey(refUrls.join("|"));
        setErr(null);
        return j.lockText;
      } catch (e) {
        setErr(e instanceof Error ? e.message : "Item analysis failed");
        return null;
      }
    },
    [itemType],
  );

  /** FLATS (from carbon-gen): one clean front/back flat image generated from
   *  the item references, split into two 3:4 crops and ADDED to the item
   *  references — so analysis + panel generation work from clean views. */
  const createFlats = useCallback(async () => {
    if (!itemRefs.length) return setErr("Add at least one item photo first — flats are generated from your item references.");
    setBusy("flats");
    setErr(null);
    setMsg(null);
    setProgress("Creating flat front/back views from the item references…");
    let wakeLock: WakeLockSentinel | null = null;
    try {
      try {
        if (window.matchMedia("(pointer: coarse)").matches && "wakeLock" in navigator) {
          wakeLock = await navigator.wakeLock.request("screen");
        }
      } catch {
        /* unavailable */
      }
      const resp = await fetch("/api/openai/item-flat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "x-generate-stream": "1" },
        body: JSON.stringify({ itemRefs: itemRefs.map((r) => r.url), itemType }),
      });
      const json = (await resp.json().catch(() => ({}))) as { imageBase64?: string; error?: string | { message?: string } };
      if (!json.imageBase64) {
        const e = json.error;
        throw new Error((typeof e === "string" ? e : e?.message) || "Flat generation failed");
      }
      const { left, right } = await splitPanelToThreeByFour(json.imageBase64);
      setProgress("Adding the flats to the item references…");
      const added: ItemRef[] = [];
      for (const f of [
        { b64: left, name: "flat-front" },
        { b64: right, name: "flat-back" },
      ]) {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        const fd = new FormData();
        fd.append("file", new Blob([bytes], { type: "image/png" }), `${f.name}.png`);
        const r = await fetch("/api/models/upload", { method: "POST", body: fd });
        const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!r.ok || !j.url) throw new Error(j.error ?? `Flat upload failed (HTTP ${r.status})`);
        added.push({ url: j.url, preview: `data:image/png;base64,${f.b64}` });
      }
      setItemRefs((prev) => [...prev, ...added]);
      setMsg("Flat front + back created and added to the item references.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Flat generation failed");
    } finally {
      setBusy(null);
      setProgress("");
      void wakeLock?.release().catch(() => {});
    }
  }, [itemRefs, itemType]);

  const generate = useCallback(async () => {
    if (!model) return setErr("Pick a model first.");
    if (!itemRefs.length) return setErr("Add at least one item photo (upload or phone camera).");
    if (!panels.length) return setErr("Select at least one panel.");
    const refUrls = itemRefs.map((r) => r.url);
    setBusy("generate");
    setNativeBusy(true);
    setErr(null);
    setMsg(null);
    // Analyze the item references FIRST (unless switched off, or the current
    // spec already covers exactly these photos): every word, graphic, material,
    // hardware piece and stitch is inventoried and locked into the prompt.
    let specForRun = itemSpec.trim();
    if (!specForRun || specRefsKey !== refUrls.join("|")) {
      setProgress("Analyzing item details (text, graphics, materials, hardware, stitching)…");
      const analyzed = await analyzeItem(refUrls);
      if (!analyzed) {
        setBusy(null);
        setNativeBusy(false);
        setProgress("");
        return; // analyzeItem already surfaced the error
      }
      specForRun = analyzed;
    }
    // Regenerate flow (carbon-gen): keep the crops you selected, append fresh
    // ones below; unselected old crops are dropped. runTag keeps ids unique.
    const kept = crops.length > 0 ? crops.filter((c) => c.selected && c.b64) : [];
    const runTag = Date.now().toString(36);
    const chosen = [...panels].sort((a, b) => a - b);
    // One facial expression per run so the model doesn't look robotic across
    // products; kept consistent across this run's panels for set coherence.
    const expressionDirective = pickExpressionDirective();
    setProgress(`Generating ${chosen.length} panel(s) in parallel…`);
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
    writePendingRun({
      matrixId,
      runTag,
      gender: model.gender,
      startedAt: Date.now(),
      jobs: chosen.map((p) => ({ panel: p, jobId: jobIds.get(p)! })),
    });

    const genOnePanel = async (panel: number): Promise<Crop[]> => {
      const jobId = jobIds.get(panel)!;
      const [poseA, poseB] = getPanelPosePair(model.gender, panel);
      const panelLabel = getPanelButtonLabel(model.gender, panel);
      const prompt = buildMasterPanelPrompt({
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
        // itemSpec travels as its own request field (server appends it inside the
        // protected lock block) — NOT inside the prompt, which is near the
        // model's length limit and gets trimmed from the middle.
      });
      const deadline = Date.now() + JOB_POLL_TIMEOUT_MS;
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
          },
          body: JSON.stringify({
            prompt,
            size: "1536x1024",
            modelRefs: model.ref_image_urls,
            itemRefs: refUrls,
            panelQa: { panelNumber: panel, panelLabel, poseA, poseB, modelName: model.name, modelGender: model.gender, itemType },
            itemSpec: specForRun || undefined,
          }),
        });
        const parsed = (await resp.json().catch(() => null)) as PanelResponse | null;
        // A body that says nothing useful means the stream was cut mid-flight
        // (frozen page, dropped carrier connection) — go claim the real result.
        json = parsed && (parsed.imageBase64 || parsed.error || parsed.degraded) ? parsed : null;
      } catch {
        json = null; // connection died — the render is still running server-side
      }
      if (!json) json = await claimPanelJob(jobId, deadline);
      else releasePanelJob(jobId);
      return panelResponseToCrops(json, panel, poseA, poseB, runTag);
    };

    try {
      // Fire every selected panel AT ONCE (like carbon-gen), not one at a time.
      const settled = await Promise.allSettled(chosen.map((p) => genOnePanel(p)));
      const all: Crop[] = [];
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") all.push(...s.value);
        else
          all.push({
            id: `p${chosen[i]}-fail-${runTag}`,
            b64: "",
            label: `Panel ${chosen[i]}: ${s.reason instanceof Error ? s.reason.message : "failed"}`,
            selected: false,
          });
      });
      setCrops([...kept, ...all]);
      setMsg(`Generated ${all.filter((c) => c.b64).length} crop(s). Select what to keep, then push${kept.length ? ` (kept ${kept.length})` : ""}.`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Generation failed");
    } finally {
      writePendingRun(null);
      setNativeBusy(false);
      setBusy(null);
      setProgress("");
      void wakeLock?.release().catch(() => {});
    }
  }, [model, itemRefs, panels, itemType, instruction, crops, matrixId, itemSpec, specRefsKey, analyzeItem]);

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
    void (async () => {
      setBusy("generate");
      setNativeBusy(true);
      setProgress(`Reconnecting to ${run.jobs.length} panel(s) still generating…`);
      try {
        const deadline = Math.min(Date.now() + JOB_POLL_TIMEOUT_MS, run.startedAt + JOB_MAX_AGE_MS);
        const settled = await Promise.allSettled(
          run.jobs.map(async ({ panel, jobId }) => {
            const [poseA, poseB] = getPanelPosePair(run.gender, panel);
            const json = await claimPanelJob(jobId, deadline);
            return panelResponseToCrops(json, panel, poseA, poseB, run.runTag);
          }),
        );
        if (cancelled) return;
        const recovered = settled.flatMap((s) => (s.status === "fulfilled" ? s.value : []));
        const ok = recovered.filter((c) => c.b64);
        setCrops((prev) => [...prev, ...recovered]);
        setMsg(
          ok.length
            ? `Recovered ${ok.length} crop(s) from the run that was interrupted.`
            : "The interrupted run could not be recovered — please generate again.",
        );
      } finally {
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
        const m = c.label.match(/Pose (\d+)/);
        return m ? Number(m[1]) : 0;
      };
      const isMale = (model?.gender || "").toLowerCase() === "male";
      const rank = isMale
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
        body: JSON.stringify({ matrixId, items }),
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
  }, [matrixId, mediaItems, colorOpts]);

  const label = "block text-[0.74rem] uppercase tracking-wide text-[var(--wms-muted)] mb-1";
  const field =
    "w-full rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] px-2 py-1.5 font-mono text-[0.85rem] text-[var(--wms-fg)]";
  // One colour → the hero is auto-assigned as its main pic; many colours → the
  // operator picks one image per colour (each pick locks that colour out of the rest).
  const singleColor = colorOpts.length === 1 ? colorOpts[0] : null;

  return (
    <div className="space-y-3">
      {/* Item photos */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (canManage) setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!canManage) return;
          const imgs = imageFilesFromTransfer(e.dataTransfer);
          if (imgs.length) void uploadItems(imgs);
        }}
        className={`rounded-md border p-3 transition-colors ${
          dragOver
            ? "border-2 border-dashed border-[var(--wms-accent)] bg-[var(--wms-accent)]/10"
            : "border-[var(--wms-border)] bg-[var(--wms-surface-elevated)]/40"
        }`}
      >
        <span className={label}>Item photo(s) — the garment reference</span>
        <p className="mb-2 font-mono text-[0.68rem] text-[var(--wms-muted)]">
          Drag &amp; drop images here, paste from clipboard (⌘/Ctrl+V), upload, or use the phone camera.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {itemRefs.map((ref, i) => (
            <div key={ref.url + i} className="relative">
              {ref.preview ? (
                <img
                  src={ref.preview}
                  alt="item ref"
                  title="Click to view full size"
                  className="h-28 w-24 cursor-zoom-in rounded border border-[var(--wms-border)] object-cover"
                  onClick={() => setZoom(ref.preview as string)}
                />
              ) : (
                <div className="flex h-28 w-24 items-center justify-center rounded border border-[var(--wms-border)] bg-[var(--wms-surface)] text-center font-mono text-[0.62rem] text-[var(--wms-status-success-fg)]">
                  ✓ photo
                </div>
              )}
              <button
                type="button"
                onClick={() => setItemRefs((p) => p.filter((x) => x.url !== ref.url))}
                className="absolute -right-1 -top-1 rounded-full bg-[var(--wms-surface)] px-1 text-[0.74rem] text-[var(--wms-status-danger-fg)]"
              >
                ✕
              </button>
            </div>
          ))}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = e.target.files ? Array.from(e.target.files) : [];
              if (files.length) void uploadItems(files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            disabled={!canManage || busy === "upload"}
            onClick={() => {
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
            {busy === "upload" ? "…" : "＋ Upload"}
          </button>
          <button
            type="button"
            disabled={!canManage}
            onClick={() => void startPhoneCamera()}
            className="rounded-md border border-dashed border-[var(--wms-border)] px-3 py-2 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50"
          >
            📱 Phone camera (QR)
          </button>
          <button
            type="button"
            disabled={!canManage || busy !== null || !itemRefs.length}
            onClick={() => void createFlats()}
            title="Generate a clean front + back flat of the item from these references and add both views to the item references (carbon-gen flats)"
            className="rounded-md border border-dashed border-[var(--wms-border)] px-3 py-2 font-mono text-[0.74rem] uppercase tracking-wide text-[var(--wms-accent)] disabled:opacity-50"
          >
            {busy === "flats" ? "… Creating flats" : "✦ Create flats"}
          </button>
        </div>
        {qr ? (
          <div className="mt-3 flex items-center gap-3 rounded-md border border-[var(--wms-border)] bg-[var(--wms-surface)] p-3">
            <img src={qr.url} alt="Scan with your phone" className="h-32 w-32 rounded bg-white p-1" />
            <div className="font-mono text-[0.74rem] text-[var(--wms-muted)]">
              Scan with your phone to take product photos. Each photo you send appears here — send as
              many as you like, then click Done.
              <button
                type="button"
                onClick={() => setQr(null)}
                className="mt-2 block rounded border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-2 py-1 text-[var(--wms-fg)]"
              >
                ✓ Done
              </button>
            </div>
          </div>
        ) : null}
      </div>

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
          <span className={label}>Item type</span>
          <input className={field} value={itemType} onChange={(e) => setItemType(e.target.value)} />
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
              {model ? getPanelButtonLabel(model.gender, p) : `Panel ${p}`}
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
                ? panels.map((p) => `P${p}: pose ${getPanelPosePair(model.gender, p).join("+")}`).join(" · ")
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

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={!canManage || busy !== null || !model || !itemRefs.length || !panels.length}
          onClick={() => void generate()}
          className="rounded-md border border-[var(--wms-accent)]/60 bg-[var(--wms-accent)]/15 px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-fg)] hover:bg-[var(--wms-accent)]/25 disabled:opacity-50"
        >
          {busy === "generate"
            ? "Generating…"
            : crops.length
              ? `↻ Regenerate ${panels.length}`
              : `✦ Generate ${panels.length} panel(s)`}
        </button>
        <button
          type="button"
          disabled={!canManage || mediaBusy !== null}
          onClick={() => void openMediaManager()}
          title="Arrange images, set the hero, alt text, delete, and publish to Shopify"
          className="rounded-md border border-[var(--wms-accent)] bg-[var(--wms-accent)] px-3 py-1.5 font-mono text-[0.78rem] uppercase tracking-wide text-[var(--wms-accent-fg)] hover:brightness-110 disabled:opacity-50"
        >
          {mediaBusy === "load" ? "Loading…" : "🖼 Manage & publish images"}
        </button>
        {progress ? <span className="font-mono text-[0.74rem] text-[var(--wms-accent)]">{progress}</span> : null}
        {msg ? <span className="font-mono text-[0.74rem] text-[var(--wms-muted)]">{msg}</span> : null}
        {err ? <span className="font-mono text-[0.74rem] text-[var(--wms-status-danger-fg)]">{err}</span> : null}
      </div>

      {!shopifyProductId ? (
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
                  onClick={() => setZoom(`data:image/png;base64,${c.b64}`)}
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
                      onClick={() => setZoom(m.url)}
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

      {zoom ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/85 p-6"
          onClick={() => setZoom(null)}
        >
          <img src={zoom} alt="Full size" className="max-h-full max-w-full rounded-lg" />
          <button
            type="button"
            onClick={() => setZoom(null)}
            className="absolute right-4 top-4 rounded-md bg-white/10 px-3 py-1.5 font-mono text-[0.85rem] text-white"
          >
            ✕ Close
          </button>
        </div>
      ) : null}
    </div>
  );
}
