/**
 * CarbonWMS Creative — Kling direct (owner, 2026-11-15: "why through fal and not directly from Kling — I have a
 * Kling API"). Kling 4.0 Omni (POST /omni-video/kling-4.0, Bearer KLING_API_KEY) takes in ONE request: the
 * first frame, the last frame, the person's reference photos and a fixed voice, with native audio (dialogue +
 * room sound), 9:16, 3–30 s. fal stays as the backup engine.
 *
 * Voices: each cast model gets ONE Kling custom voice, made once from a short sample of their CarbonWMS voice,
 * so the same person always sounds the same (before, every clip invented its own voice).
 */
import type { Pool } from "pg";
import { PlainError, recordSpend } from "./config";
import type { CastModel } from "./casting";
import { speak } from "./engines";
import { putFile, signedUrl } from "./storage";
import type { JobResult } from "./engines";

const BASE = (process.env.KLING_API_BASE || "https://api-singapore.klingai.com").replace(/\/+$/, "");
export const KLING4 = "kling-direct/kling-4.0-omni";
/** USD per Kling API unit (resource packages); Kling 4.0 at 1080p = 1.5 units per second. */
export const KLING_UNIT_USD = Number(process.env.KLING_UNIT_USD || 0.14);

export function klingKey(): string {
  return (process.env.KLING_API_KEY || "").trim();
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const key = klingKey();
  if (!key) throw new PlainError("Kling needs KLING_API_KEY on the server.");
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? (init.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json().catch(() => ({}))) as { code?: number; message?: string; data?: T };
  if (!r.ok || (j.code ?? 0) !== 0) throw new PlainError(`Kling refused the request (HTTP ${r.status}, code ${j.code ?? "?"}: ${(j.message ?? "").slice(0, 200)})`);
  return j.data as T;
}

export type KlingClip = {
  prompt: string;
  firstFrame: string; // signed URL
  lastFrame?: string | null;
  personRefs?: string[]; // signed URLs of the cast member's photos
  voiceId?: string | null;
  seconds: number;
  aspect: string;
};

export async function submitKlingOmni(v: KlingClip): Promise<{ taskId: string; seconds: number; input: unknown }> {
  const seconds = Math.min(30, Math.max(3, Math.round(v.seconds)));
  const refs = (v.personRefs ?? []).slice(0, 3);
  const lead = [
    `@f1 is the first frame${v.lastFrame ? " and @f2 is the last frame — the video moves from @f1 to @f2" : ""}.`,
    refs.length ? `${refs.map((_, i) => `@p${i + 1}`).join(", ")} show the same person: keep the face, hair, skin tone and body exactly identical in every frame.` : "",
    v.voiceId ? "Whenever the person speaks, she or he speaks in English using @v1 — the same voice for every word, with accurate lip synchronization." : "",
  ]
    .filter(Boolean)
    .join(" ");
  const contents: Record<string, unknown>[] = [
    { type: "prompt", text: `${lead} ${v.prompt}`.slice(0, 20000) },
    { type: "first_frame", url: v.firstFrame, id: "f1" },
    ...refs.map((url, i) => ({ type: "refer_image", url, id: `p${i + 1}` })),
    ...(v.lastFrame ? [{ type: "last_frame", url: v.lastFrame, id: "f2" }] : []),
    ...(v.voiceId ? [{ type: "voice", voice_id: v.voiceId, id: "v1" }] : []),
  ];
  const input = {
    contents,
    settings: { audio: "native", resolution: "1080p", aspect_ratio: v.aspect === "4:5" ? "3:4" : v.aspect, duration: seconds },
    options: { watermark_info: { enabled: false } },
  };
  const d = await call<{ id: string }>("/omni-video/kling-4.0", { body: input });
  if (!d?.id) throw new PlainError("Kling returned no task id.");
  return { taskId: d.id, seconds, input };
}

export async function pollKling(taskId: string): Promise<JobResult> {
  const d = await call<{ id: string; status: string; message?: string; outputs?: { type: string; url?: string }[] }[]>(`/tasks?task_ids=${encodeURIComponent(taskId)}`);
  const t = d?.[0];
  if (!t || t.status === "submitted" || t.status === "processing") return { state: "pending", note: t?.status ?? "submitted" };
  if (t.status !== "succeeded") return { state: "failed", error: `Kling: ${t.message || t.status}` };
  const url = t.outputs?.find((o) => o.type === "video")?.url;
  if (!url) return { state: "failed", error: "Kling returned no video" };
  return { state: "done", url, contentType: "video/mp4" };
}

/** A neutral sample (no product claims) — only the sound of the voice is used. */
const SAMPLE =
  "Okay so, quick one. I literally just got back, and I have to show you guys this. Honestly, I was not expecting it to look this good. Like, look at this. Anyway, let me know what you think, okay? Love you, bye.";

/** The cast member's Kling voice: made once (≈ 1¢), then the same voice in every clip. */
export async function ensureKlingVoice(pool: Pool, tenantId: string, m: CastModel, projectId?: string | null): Promise<string | null> {
  if (!klingKey()) return null;
  const have = await pool.query<{ kling_voice_id: string | null }>(`SELECT kling_voice_id FROM creative_model_meta WHERE tenant_id = $1::uuid AND model_id = $2`, [tenantId, m.id]);
  if (have.rows[0]?.kling_voice_id) return have.rows[0].kling_voice_id;
  const v = await speak(SAMPLE, m.voice ?? (m.gender === "male" ? "ash" : "coral"), `A real ${m.gender === "male" ? "guy" : "girl"} talking to their phone: ${m.personality ?? "relaxed, warm, confident"}. Casual, natural, not an announcer.`);
  await recordSpend(pool, tenantId, { provider: "openai", what: `voice sample for ${m.name}`, cost: v.cost, projectId: projectId ?? null });
  const path = await putFile(`creative/voices/${tenantId}/${m.id}-${Date.now()}.mp3`, v.bytes, "audio/mpeg");
  const task = await call<{ task_id: string }>("/v1/general/custom-voices", { body: { voice_name: m.name.slice(0, 20), voice_url: signedUrl(path, 3600) } });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await call<{ task_status: string; task_status_msg?: string; task_result?: { voices?: { voice_id: string }[] } }>(`/v1/general/custom-voices/${task.task_id}`);
    if (s.task_status === "failed") throw new PlainError(`Kling could not make ${m.name}'s voice: ${s.task_status_msg ?? "failed"}`);
    const id = s.task_result?.voices?.[0]?.voice_id;
    if (s.task_status === "succeed" || s.task_status === "succeeded" || id) {
      if (!id) break;
      await pool.query(
        `INSERT INTO creative_model_meta (tenant_id, model_id, kling_voice_id) VALUES ($1::uuid, $2, $3)
         ON CONFLICT (tenant_id, model_id) DO UPDATE SET kling_voice_id = EXCLUDED.kling_voice_id`,
        [tenantId, m.id, id],
      );
      await recordSpend(pool, tenantId, { provider: "fal", what: `Kling voice for ${m.name}`, cost: 0.05 * KLING_UNIT_USD, projectId: projectId ?? null });
      return id;
    }
  }
  return null; // not ready in time — the clip goes without a fixed voice rather than waiting forever
}
