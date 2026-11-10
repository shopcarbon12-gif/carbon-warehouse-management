/**
 * CarbonWMS Creative — which engine does which job (spec §12). The owner never picks;
 * Settings → "⋯ More" can override a row. Two paid keys only:
 *   OpenAI (owner's key)  — every LLM job, stills / try-on, TTS. Batch API for anything not urgent.
 *   fal.ai (FAL_KEY)      — video only (Kling, Veo, Seedance behind one key).
 *
 * Prices are fal's published list prices (fal.ai model pages, checked 2026-11-09). fal does not
 * return a cost per request, so video cost_usd is written from these and marked estimated.
 */

export type VideoJob = "fashion_motion" | "ugc_talking" | "identity" | "draft";

export type VideoEngine = {
  id: string; // fal endpoint id
  label: string;
  /** Input image field name. */
  imageField: "start_image_url" | "image_url" | "image_urls";
  /** Allowed durations (seconds) and how the endpoint wants them written. */
  durations: number[];
  durationFormat: "plain" | "s_suffix";
  aspectField: boolean;
  /** $ per second, audio off / on. */
  perSecond: { silent: number; audio: number };
  nativeDialogue: boolean;
};

export const VIDEO_ENGINES: Record<string, VideoEngine> = {
  "fal-ai/kling-video/v3/pro/image-to-video": {
    id: "fal-ai/kling-video/v3/pro/image-to-video",
    label: "Kling 3.0 Pro",
    imageField: "start_image_url",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationFormat: "plain",
    aspectField: false,
    perSecond: { silent: 0.112, audio: 0.168 },
    nativeDialogue: true,
  },
  "fal-ai/kling-video/o3/pro/image-to-video": {
    id: "fal-ai/kling-video/o3/pro/image-to-video",
    label: "Kling O3 Pro",
    imageField: "start_image_url",
    durations: [3, 4, 5, 6, 7, 8, 9, 10],
    durationFormat: "plain",
    aspectField: false,
    perSecond: { silent: 0.112, audio: 0.168 },
    nativeDialogue: true,
  },
  "fal-ai/kling-video/v3/standard/image-to-video": {
    id: "fal-ai/kling-video/v3/standard/image-to-video",
    label: "Kling 3.0 Standard",
    imageField: "start_image_url",
    durations: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationFormat: "plain",
    aspectField: false,
    perSecond: { silent: 0.084, audio: 0.126 },
    nativeDialogue: true,
  },
  "fal-ai/veo3.1/image-to-video": {
    id: "fal-ai/veo3.1/image-to-video",
    label: "Google Veo 3.1",
    imageField: "image_url",
    durations: [4, 6, 8],
    durationFormat: "s_suffix",
    aspectField: true,
    perSecond: { silent: 0.2, audio: 0.4 },
    nativeDialogue: true,
  },
  "fal-ai/veo3.1/fast/image-to-video": {
    id: "fal-ai/veo3.1/fast/image-to-video",
    label: "Google Veo 3.1 Fast",
    imageField: "image_url",
    durations: [4, 6, 8],
    durationFormat: "s_suffix",
    aspectField: true,
    perSecond: { silent: 0.1, audio: 0.15 },
    nativeDialogue: true,
  },
  "bytedance/seedance-2.0/reference-to-video": {
    id: "bytedance/seedance-2.0/reference-to-video",
    label: "Seedance 2.0 (Reference)",
    imageField: "image_urls",
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    durationFormat: "plain",
    aspectField: true,
    // Billed per 1,000 video tokens ($0.014 at 720p): ~108k tokens for 5 s of 1280x720 at 24 fps.
    perSecond: { silent: 0.3, audio: 0.3 },
    nativeDialogue: true,
  },
  "bytedance/seedance-2.0/mini/reference-to-video": {
    id: "bytedance/seedance-2.0/mini/reference-to-video",
    label: "Seedance 2.0 Mini (drafts)",
    imageField: "image_urls",
    durations: [4, 5, 6, 7, 8, 9, 10],
    durationFormat: "plain",
    aspectField: true,
    perSecond: { silent: 0.12, audio: 0.12 },
    nativeDialogue: false,
  },
};

/** Default routing (spec §12 table). First = default; the rest are the auto-fallback order. */
export const DEFAULT_ROUTES: Record<VideoJob, { label: string; why: string; engines: string[] }> = {
  fashion_motion: {
    label: "Product / fashion motion (walks, spins, fabric, outfit swaps)",
    why: "Best garment fidelity + fabric physics",
    engines: ["fal-ai/kling-video/v3/pro/image-to-video", "fal-ai/kling-video/o3/pro/image-to-video", "bytedance/seedance-2.0/reference-to-video"],
  },
  ugc_talking: {
    label: "UGC / people talking / natural human motion",
    why: "Most natural movement + native dialogue",
    engines: ["fal-ai/veo3.1/image-to-video", "fal-ai/veo3.1/fast/image-to-video", "fal-ai/kling-video/v3/pro/image-to-video"],
  },
  identity: {
    label: "Same face across many clips (saved models)",
    why: "Identity consistency",
    engines: ["bytedance/seedance-2.0/reference-to-video", "fal-ai/kling-video/v3/pro/image-to-video"],
  },
  draft: {
    label: "Drafts / previews",
    why: "Cheap",
    engines: ["bytedance/seedance-2.0/mini/reference-to-video", "fal-ai/kling-video/v3/standard/image-to-video"],
  },
};

export function routeFor(job: VideoJob, overrides: Record<string, unknown> | null | undefined): string[] {
  const o = overrides?.[job];
  if (Array.isArray(o) && o.every((x) => typeof x === "string" && VIDEO_ENGINES[x])) return o as string[];
  return DEFAULT_ROUTES[job].engines;
}

/** Nearest allowed duration ≥ the wanted one (or the longest). */
export function engineDuration(engine: VideoEngine, wanted: number): number {
  return engine.durations.find((d) => d >= Math.ceil(wanted - 0.05)) ?? engine.durations[engine.durations.length - 1];
}

export function estimateVideoCost(engineId: string, seconds: number, audio: boolean): number {
  const e = VIDEO_ENGINES[engineId];
  if (!e) return 0;
  return Math.round((audio ? e.perSecond.audio : e.perSecond.silent) * seconds * 10000) / 10000;
}

/**
 * OpenAI list prices used to turn token usage into cost_usd (estimated = true). Unknown models
 * fall back to the gpt-5.5 row. Batch = 50% off.
 */
export const OPENAI_TEXT_PRICES: Record<string, { in: number; out: number }> = {
  // $ per 1M tokens
  "gpt-5.5": { in: 1.25, out: 10 },
  "gpt-5.5-mini": { in: 0.25, out: 2 },
  "gpt-6-astra": { in: 2.5, out: 15 },
};
export function textCost(model: string, inTok: number, outTok: number, batch = false): number {
  const p = OPENAI_TEXT_PRICES[model] ?? OPENAI_TEXT_PRICES["gpt-5.5"];
  const c = (inTok * p.in + outTok * p.out) / 1_000_000;
  return Math.round((batch ? c / 2 : c) * 10000) / 10000;
}
/** gpt-image list price per picture at quality high (portrait 1024x1536 ≈ $0.25; edits with refs add input tokens). */
export const IMAGE_COST = { high: 0.25, medium: 0.07, low: 0.02 } as const;
/** OpenAI TTS: $15 per 1M characters (tts-1 class); gpt-4o-mini-tts ≈ $0.015/min. */
export const TTS_COST_PER_CHAR = 15 / 1_000_000;
