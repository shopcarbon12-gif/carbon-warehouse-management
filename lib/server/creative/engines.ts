/**
 * CarbonWMS Creative — engine adapters (spec §12 "Adapter interfaces").
 *
 *   ImageGenProvider / TryOnProvider → OpenAI images (owner's key), reference images attached.
 *   VideoGenProvider                 → fal.ai queue API (Kling / Veo / Seedance behind FAL_KEY).
 *   LipSyncProvider                  → engines with native dialogue (Veo / Kling / Seedance audio);
 *                                      the line to say goes in the prompt — no separate lip-sync call.
 *   TTSProvider                      → OpenAI TTS.
 * Keys stay on the server; the client never sees them.
 */
import { toFile } from "openai";
import { falKey, imageModel, openai, PlainError, ttsModel } from "./config";
import { engineDuration, IMAGE_COST, TTS_COST_PER_CHAR, VIDEO_ENGINES, estimateVideoCost } from "./routing";

export type JobRef = { provider: "openai" | "fal"; externalId: string; meta?: Record<string, unknown> };
export type JobResult =
  | { state: "pending"; note?: string }
  | { state: "failed"; error: string }
  | { state: "done"; url?: string; bytes?: Buffer; contentType?: string; meta?: Record<string, unknown> };

export type Size = "1024x1536" | "1536x1024" | "1024x1024";
export const SIZE_FOR_ASPECT: Record<string, Size> = { "9:16": "1024x1536", "4:5": "1024x1536", "1:1": "1024x1024", "16:9": "1536x1024" };

/* ------------------------------------------------------------------ OpenAI images */

export type ImageRef = { name: string; bytes: Buffer; mime?: string };

/**
 * One still. With references → images.edit (model sheet + garment cut-outs + location), without →
 * images.generate. Returns PNG/JPEG bytes and the list-price cost (estimated).
 */
export async function generateImage(req: { prompt: string; refs?: ImageRef[]; size?: Size; quality?: "high" | "medium" | "low" }): Promise<{ bytes: Buffer; cost: number; model: string }> {
  const model = imageModel();
  const quality = req.quality ?? "high";
  const size = req.size ?? "1024x1536";
  const client = openai();
  let b64: string | undefined;
  if (req.refs?.length) {
    const files = await Promise.all(req.refs.slice(0, 16).map((r) => toFile(r.bytes, r.name, { type: r.mime ?? "image/png" })));
    const r = await client.images.edit({ model, prompt: req.prompt, image: files, size, quality, n: 1 } as Parameters<typeof client.images.edit>[0]);
    b64 = (r as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
  } else {
    const r = await client.images.generate({ model, prompt: req.prompt, size, quality, n: 1 } as Parameters<typeof client.images.generate>[0]);
    b64 = (r as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
  }
  if (!b64) throw new PlainError("The picture model returned no picture (it may have been blocked by its safety filter). Try a different shot or pose.");
  const refCost = (req.refs?.length ?? 0) * 0.01;
  return { bytes: Buffer.from(b64, "base64"), cost: IMAGE_COST[quality] + refCost, model };
}

/* ------------------------------------------------------------------ fal.ai video */

const QUEUE = "https://queue.fal.run";

function falHeaders() {
  const k = falKey();
  if (!k) throw new PlainError("Video needs a fal.ai key. Add FAL_KEY on the server (fal.ai → API keys), then try again.");
  return { Authorization: `Key ${k}`, "Content-Type": "application/json" };
}

export type VideoRequest = {
  engineId: string;
  prompt: string;
  imageUrl: string; // first frame (approved still), signed URL
  referenceUrls?: string[]; // identity refs (Seedance reference mode)
  endImageUrl?: string;
  seconds: number;
  aspect: "9:16" | "16:9" | "1:1" | "4:5";
  audio: boolean;
  negative?: string;
};

export function buildVideoInput(v: VideoRequest): { input: Record<string, unknown>; seconds: number } {
  const e = VIDEO_ENGINES[v.engineId];
  if (!e) throw new Error(`unknown engine ${v.engineId}`);
  const secs = engineDuration(e, v.seconds);
  const input: Record<string, unknown> = { prompt: v.prompt };
  if (e.imageField === "image_urls") {
    input.image_urls = [v.imageUrl, ...(v.referenceUrls ?? [])].slice(0, 9);
    input.prompt = `@Image1 is the first frame and the exact outfit.${v.referenceUrls?.length ? ` @Image2${v.referenceUrls.length > 1 ? `–@Image${v.referenceUrls.length + 1}` : ""} show the same person's face and body — keep them identical.` : ""} ${v.prompt}`;
    input.resolution = "720p";
  } else {
    input[e.imageField] = v.imageUrl;
  }
  if (v.endImageUrl && e.imageField === "start_image_url") input.end_image_url = v.endImageUrl;
  input.duration = e.durationFormat === "s_suffix" ? `${secs}s` : String(secs);
  if (e.aspectField) input.aspect_ratio = v.aspect === "4:5" ? (e.id.includes("veo") ? "9:16" : "3:4") : v.aspect;
  input.generate_audio = v.audio;
  if (v.negative && e.imageField === "start_image_url") input.negative_prompt = v.negative;
  return { input, seconds: secs };
}

export async function submitVideo(v: VideoRequest): Promise<JobRef & { cost: number; seconds: number }> {
  const { input, seconds } = buildVideoInput(v);
  const r = await fetch(`${QUEUE}/${v.engineId}`, { method: "POST", headers: falHeaders(), body: JSON.stringify(input), signal: AbortSignal.timeout(60_000) });
  const j = (await r.json().catch(() => ({}))) as { request_id?: string; status_url?: string; response_url?: string; detail?: unknown };
  if (!r.ok || !j.request_id) throw new PlainError(`fal.ai refused the video request (HTTP ${r.status}: ${JSON.stringify(j.detail ?? j).slice(0, 200)}).`);
  return {
    provider: "fal",
    externalId: j.request_id,
    meta: { status_url: j.status_url, response_url: j.response_url, engine: v.engineId, input },
    cost: estimateVideoCost(v.engineId, seconds, v.audio),
    seconds,
  };
}

export async function pollVideo(meta: { status_url?: string; response_url?: string; engine?: string }, requestId: string): Promise<JobResult> {
  const statusUrl = meta.status_url ?? `${QUEUE}/${meta.engine}/requests/${requestId}/status`;
  const s = await fetch(statusUrl, { headers: falHeaders(), signal: AbortSignal.timeout(30_000) });
  const sj = (await s.json().catch(() => ({}))) as { status?: string; error?: string };
  if (sj.status === "IN_QUEUE" || sj.status === "IN_PROGRESS") return { state: "pending", note: sj.status };
  if (sj.status !== "COMPLETED") return { state: "failed", error: sj.error ?? `fal status ${sj.status ?? s.status}` };
  const rr = await fetch(meta.response_url ?? `${QUEUE}/${meta.engine}/requests/${requestId}`, { headers: falHeaders(), signal: AbortSignal.timeout(30_000) });
  const rj = (await rr.json().catch(() => ({}))) as { video?: { url?: string }; detail?: unknown };
  if (!rr.ok || !rj.video?.url) return { state: "failed", error: `fal returned no video (${JSON.stringify(rj.detail ?? rj).slice(0, 200)})` };
  return { state: "done", url: rj.video.url, contentType: "video/mp4" };
}

/** Quarterly catalog check (spec §12 "Model updates"): newer Kling / Veo / Seedance on fal? */
export async function falCatalog(query: string): Promise<{ id: string; title: string }[]> {
  try {
    const r = await fetch(`https://api.fal.ai/v1/models?q=${encodeURIComponent(query)}&category=image-to-video&limit=50`, {
      headers: falKey() ? { Authorization: `Key ${falKey()}` } : {},
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return [];
    const j = (await r.json()) as { models?: { endpoint_id?: string; id?: string; metadata?: { display_name?: string } }[] };
    return (j.models ?? []).map((m) => ({ id: m.endpoint_id ?? m.id ?? "", title: m.metadata?.display_name ?? m.endpoint_id ?? "" })).filter((m) => m.id);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ TTS */

export const TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"] as const;

export async function speak(text: string, voice: string, instructions?: string): Promise<{ bytes: Buffer; cost: number }> {
  const r = await openai().audio.speech.create({
    model: ttsModel(),
    voice: (TTS_VOICES as readonly string[]).includes(voice) ? voice : "ash",
    input: text.slice(0, 4000),
    response_format: "mp3",
    ...(instructions ? { instructions } : {}),
  } as Parameters<ReturnType<typeof openai>["audio"]["speech"]["create"]>[0]);
  return { bytes: Buffer.from(await r.arrayBuffer()), cost: Math.max(0.001, text.length * TTS_COST_PER_CHAR) };
}
