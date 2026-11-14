/**
 * CarbonWMS Creative — making the pieces: try-on stills (model sheet + Product Twin → still per
 * shot, critic, ≤ 2 automatic retries), video clips from approved stills (first-frame strategy,
 * routing + auto-fallback, critic), and queuing renders for the render worker.
 */
import type { Pool } from "pg";
import sharp from "sharp";
import { getBrand, getCreativeSettings, presetOf, recordSpend, spendGate, PlainError } from "./config";
import { tryGetStoragePathFromUrl } from "@/lib/storageProvider";
import { generateImage, pollVideo, submitVideo, type ImageRef } from "./engines";
import { criticize, MAX_RETRIES, retryHint, type CriticReport } from "./critic";
import { keyframes } from "./media";
import { listModels, modelRefBytes, type CastModel } from "./casting";
import { twinRefs } from "./twin";
import { getFile, putFile, signedUrl, fetchBytes } from "./storage";
import { routeFor, VIDEO_ENGINES, estimateVideoCost, IMAGE_COST, type VideoJob } from "./routing";
import type { Shot } from "./director";

export type ProjectRow = {
  id: string;
  tenant_id: string;
  campaign_id: string | null;
  role: string | null;
  title: string;
  kind: "static" | "video" | "ugc" | "animated";
  products: string[];
  cast_ids: string[];
  preset: string;
  inspiration_ad_id: string | null;
  brief: Record<string, unknown> | null;
  concepts: unknown[] | null;
  concept_idx: number | null;
  shot_list: { shots: Shot[]; music: { mood: string; bpm: number }; captions: string[] } | null;
  edit_plan: Record<string, unknown> | null;
  script: Record<string, unknown> | null;
  captions: Record<string, unknown> | null;
  status: string;
  sizes: string[];
};

export async function loadProject(pool: Pool, tenantId: string, id: string): Promise<ProjectRow> {
  const r = await pool.query<ProjectRow>(`SELECT * FROM creative_projects WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tenantId]);
  if (!r.rows[0]) throw new PlainError("That project is gone.");
  return r.rows[0];
}

export async function setProject(pool: Pool, id: string, v: Partial<Record<"status" | "step_note" | "concepts" | "concept_idx" | "shot_list" | "edit_plan" | "script" | "captions" | "cast_ids" | "preset" | "brief" | "title", unknown>>) {
  const keys = Object.keys(v);
  if (!keys.length) return;
  const json = new Set(["concepts", "shot_list", "edit_plan", "script", "captions", "brief"]);
  const sets = keys.map((k, i) => `${k} = $${i + 2}${json.has(k) ? "::jsonb" : k === "cast_ids" ? "::text[]" : ""}`);
  await pool.query(`UPDATE creative_projects SET ${sets.join(", ")}, updated_at = now() WHERE id = $1::uuid`, [id, ...keys.map((k) => (json.has(k) ? JSON.stringify(v[k as keyof typeof v]) : v[k as keyof typeof v]))]);
}

async function insertGen(pool: Pool, tenantId: string, v: { projectId: string; kind: string; shotIdx?: number | null; size?: string | null; provider: string; model?: string | null; prompt?: string | null; inputs?: unknown; status?: string; attempt?: number; draft?: boolean }) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO creative_generations (tenant_id, project_id, kind, shot_idx, size, provider, model, prompt, inputs, status, attempt, draft)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING id`,
    [tenantId, v.projectId, v.kind, v.shotIdx ?? null, v.size ?? null, v.provider, v.model ?? null, v.prompt ?? null, JSON.stringify(v.inputs ?? {}), v.status ?? "running", v.attempt ?? 1, v.draft ?? false],
  );
  return r.rows[0].id;
}

/** Garment references for the critic: cut-outs + detail crops. */
async function garmentRefs(pool: Pool, tenantId: string, products: string[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const id of products) {
    const t = (await pool.query(`SELECT cutouts, details FROM creative_product_twins WHERE tenant_id = $1::uuid AND product_id = $2`, [tenantId, id])).rows[0];
    if (!t) continue;
    for (const c of [...(t.cutouts ?? []).slice(0, 2), ...(t.details ?? []).slice(0, 2)]) {
      try {
        out.push(await sharp((await getFile(c.storage_path)).bytes).resize(768, 768, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer());
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

async function inspirationHashes(pool: Pool, adId: string | null): Promise<string[]> {
  if (!adId) return [];
  const r = await pool.query<{ phash: string | null }>(`SELECT phash FROM creative_ad_variations WHERE ad_id = $1::uuid AND phash IS NOT NULL`, [adId]);
  return r.rows.map((x) => x.phash!).filter(Boolean);
}

async function locationRef(pool: Pool, tenantId: string, name: string): Promise<ImageRef | null> {
  const r = await pool.query<{ storage_path: string | null }>(`SELECT storage_path FROM creative_locations WHERE tenant_id = $1::uuid AND lower(name) = lower($2) AND storage_path IS NOT NULL LIMIT 1`, [tenantId, name]);
  const p = r.rows[0]?.storage_path;
  if (!p) return null;
  try {
    return { name: "location.jpg", bytes: await sharp((await getFile(p)).bytes).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer(), mime: "image/jpeg" };
  } catch {
    return null;
  }
}

export const STILL_COST = IMAGE_COST.high + 0.06 + 0.02; // picture + refs + critic

/**
 * One shot's still, critic-gated. Returns the passing generation (or null after the retries).
 * `quality` low = storyboard thumbnails (no critic).
 */
export async function makeStill(pool: Pool, p: ProjectRow, shot: Shot, opts: { quality?: "high" | "medium" | "low"; extra?: string; draft?: boolean; look?: string } = {}): Promise<{ genId: string; path: string; critic: CriticReport | null } | null> {
  const tid = p.tenant_id;
  const brand = await getBrand(pool, tid);
  const preset = presetOf(brand, p.preset);
  const models = await listModels(pool, tid);
  const cast = (shot.cast?.length ? shot.cast : p.cast_ids).map((id) => models.find((m) => m.id === id)).filter((m): m is CastModel => Boolean(m));
  const products = shot.products?.length ? shot.products : p.products;
  const refs: ImageRef[] = [];
  const low = opts.quality === "low"; // storyboard thumbnail: one garment reference, no people refs
  for (const m of low ? [] : cast.slice(0, 4)) {
    const b = await modelRefBytes(m, shot.is_end_card ? 0 : 3);
    b.forEach((x, i) => refs.push({ name: `person-${m.name}-${i}.jpg`, bytes: x, mime: "image/jpeg" }));
  }
  const garments = await twinRefs(pool, tid, products);
  if (!garments.length && !shot.is_end_card) throw new PlainError("The product twin has no cut-outs yet. Build and confirm the product first.");
  (low ? garments.slice(0, 1) : garments).forEach((g, i) => refs.push({ name: `garment-${i}-${g.angle}.png`, bytes: g.bytes, mime: "image/png" }));
  const loc = low ? null : await locationRef(pool, tid, shot.location);
  if (loc) refs.push(loc);
  const crit = await garmentRefs(pool, tid, products);
  const insp = await inspirationHashes(pool, p.inspiration_ad_id);
  const quality = opts.quality ?? "high";
  const prompt0 = [
    shot.still_prompt,
    `LOOK: ${opts.look || preset.look}. Camera: ${shot.camera_move.replace(/_/g, " ")}, ${shot.lens} lens. Light: ${shot.lighting}. Location: ${shot.location}.`,
    cast.length ? `PEOPLE: the person references show ${cast.map((m) => m.name).join(" and ")} — keep each face, skin tone, hair and body EXACTLY.` : "",
    `CLOTHES: the garment references (${garments.map((g) => `${g.title} ${g.angle}`).join(", ")}) are the real CARBON products — dress the people in EXACTLY these: same colour and wash, graphic / logo letter-for-letter, stitching, hardware, fit and length. ${shot.garment_must_show}.`,
    "Photoreal fashion campaign photo, real skin texture, natural hands. No added text, captions, watermarks or other brands' logos.",
    opts.extra ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  let best: { genId: string; path: string; critic: CriticReport } | null = null;
  for (let attempt = 1; attempt <= (quality === "low" ? 1 : MAX_RETRIES + 1); attempt++) {
    const est = (quality === "low" ? IMAGE_COST.low : quality === "medium" ? IMAGE_COST.medium : IMAGE_COST.high) + refs.length * 0.01 + (quality === "low" ? 0 : 0.02);
    await spendGate(pool, tid, "openai", est);
    const prompt = attempt === 1 ? prompt0 : `${prompt0}\nRETRY — the quality check found: ${retryHint(best!.critic)}`;
    const genId = await insertGen(pool, tid, { projectId: p.id, kind: quality === "low" ? "sample" : "still", shotIdx: shot.idx, provider: "openai", prompt, attempt, draft: opts.draft, inputs: { refs: refs.map((r) => r.name) } });
    try {
      const g = await generateImage({ prompt, refs, size: "1024x1536", quality });
      await recordSpend(pool, tid, { provider: "openai", what: `still shot ${shot.idx + 1} (${p.title})`, cost: g.cost, projectId: p.id, generationId: genId });
      const path = await putFile(`creative/projects/${p.id}/still-${shot.idx}-${genId.slice(0, 8)}.png`, g.bytes, "image/png");
      if (quality === "low") {
        await pool.query(`UPDATE creative_generations SET status = 'done', output_path = $2, model = $3, cost_usd = $4, updated_at = now() WHERE id = $1::uuid`, [genId, path, g.model, g.cost]);
        return { genId, path, critic: null };
      }
      const frame = await sharp(g.bytes).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer();
      const c = await criticize(pool, tid, { frames: [frame], kind: "still", garmentRefs: crit, shot, preset: p.preset, projectId: p.id, inspirationHashes: insp, isHook: shot.idx === 0 });
      await pool.query(`UPDATE creative_generations SET status = $2, output_path = $3, model = $4, cost_usd = $5, critic = $6::jsonb, updated_at = now() WHERE id = $1::uuid`, [
        genId, c.pass ? "done" : "rejected", path, g.model, g.cost, JSON.stringify(c),
      ]);
      if (c.pass) return { genId, path, critic: c };
      if (!best || c.overall > best.critic.overall) best = { genId, path, critic: c };
    } catch (e) {
      await pool.query(`UPDATE creative_generations SET status = 'failed', error = $2, updated_at = now() WHERE id = $1::uuid`, [genId, (e as Error).message.slice(0, 500)]);
      if (e instanceof PlainError && /Paused|key/.test(e.message)) throw e;
      if (attempt > MAX_RETRIES) throw e;
      if (!best) best = { genId, path: "", critic: { overall: 0, pass: false, fails: ["error"], problems: [(e as Error).message.slice(0, 120)], note: "", garment_accuracy: 1, ai_artifacts: 1, motion_realism: null, brand_fit: 1, hook_strength: null, originality: 10, text_and_logos_seen: [], foreignBrands: [] } };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ clips */

export function videoJobFor(p: ProjectRow, shot: Shot, castUseCount: number): VideoJob {
  if (p.kind === "ugc") return "ugc_talking";
  if ((shot.cast?.length ?? 0) > 0 && castUseCount >= 3) return "identity";
  return "fashion_motion";
}

export type ClipState = { shotIdx: number; genId: string; engines: string[]; engineAt: number; tries: number; attempt: number; still: string; refs: string[]; prompt: string; seconds: number; audio: boolean; aspect: string; status: "running" | "done" | "failed"; error?: string };

/** Submit one clip (first frame = the approved still). */
export async function submitClip(pool: Pool, p: ProjectRow, st: Omit<ClipState, "genId" | "status"> & { genId?: string }): Promise<ClipState> {
  const engineId = st.engines[st.engineAt];
  const e = VIDEO_ENGINES[engineId];
  const cost = estimateVideoCost(engineId, st.seconds, st.audio);
  await spendGate(pool, p.tenant_id, "fal", cost);
  const ref = await submitVideo({ engineId, prompt: st.prompt, imageUrl: signedUrl(st.still, 24 * 3600), referenceUrls: st.refs, seconds: st.seconds, aspect: st.aspect as "9:16", audio: st.audio && e.nativeDialogue, negative: "blur, distortion, warped hands, extra fingers, morphing clothes, changing logo, text" });
  const genId = await insertGen(pool, p.tenant_id, { projectId: p.id, kind: "clip", shotIdx: st.shotIdx, provider: "fal", model: engineId, prompt: st.prompt, attempt: st.attempt, inputs: { ...ref.meta, still: st.still }, status: "running" });
  await pool.query(`UPDATE creative_generations SET external_id = $2, cost_usd = $3 WHERE id = $1::uuid`, [genId, ref.externalId, ref.cost]);
  await recordSpend(pool, p.tenant_id, { provider: "fal", what: `clip shot ${st.shotIdx + 1} (${VIDEO_ENGINES[engineId].label}, ${ref.seconds}s)`, cost: ref.cost, projectId: p.id, generationId: genId });
  return { ...st, genId, status: "running" };
}

/** Poll one clip; on done → R2 + critic (≤ 2 retries); on failure → retry once, then the next engine. */
export async function advanceClip(pool: Pool, p: ProjectRow, st: ClipState, shot: Shot): Promise<ClipState> {
  if (st.status !== "running") return st;
  const g = (await pool.query(`SELECT external_id, inputs FROM creative_generations WHERE id = $1::uuid`, [st.genId])).rows[0];
  const res = await pollVideo(g.inputs, g.external_id);
  if (res.state === "pending") return st;
  if (res.state === "failed") {
    await pool.query(`UPDATE creative_generations SET status = 'failed', error = $2, updated_at = now() WHERE id = $1::uuid`, [st.genId, res.error.slice(0, 500)]);
    // Auto-fallback: retry once on the same engine, then the next engine in the route. Logged, never asked.
    const next = st.tries < 1 ? { ...st, tries: st.tries + 1 } : { ...st, tries: 0, engineAt: st.engineAt + 1 };
    if (next.engineAt >= st.engines.length) return { ...st, status: "failed", error: `Every video engine failed for shot ${st.shotIdx + 1}: ${res.error.slice(0, 200)}` };
    return submitClip(pool, p, next);
  }
  const { bytes } = await fetchBytes(res.url!, 300 * 1024 * 1024);
  const path = await putFile(`creative/projects/${p.id}/clip-${st.shotIdx}-${st.genId.slice(0, 8)}.mp4`, bytes, "video/mp4");
  const k = await keyframes(bytes, 4, 768);
  const crit = await garmentRefs(pool, p.tenant_id, shot.products?.length ? shot.products : p.products);
  const c = await criticize(pool, p.tenant_id, { frames: k.frames, kind: "clip", garmentRefs: crit, shot, preset: p.preset, projectId: p.id, inspirationHashes: await inspirationHashes(pool, p.inspiration_ad_id), isHook: shot.idx === 0 });
  await pool.query(`UPDATE creative_generations SET status = $2, output_path = $3, output_meta = $4::jsonb, critic = $5::jsonb, updated_at = now() WHERE id = $1::uuid`, [
    st.genId, c.pass ? "done" : "rejected", path, JSON.stringify({ duration: k.duration, w: k.width, h: k.height }), JSON.stringify(c),
  ]);
  if (c.pass) return { ...st, status: "done" };
  if (st.attempt > MAX_RETRIES) {
    // Keep the best-scoring clip but say so — the owner decides (it is never shown as passed).
    return { ...st, status: "failed", error: `Shot ${st.shotIdx + 1}'s clip didn't pass the quality check after ${st.attempt} tries (${c.fails.join(", ")}): ${c.note}` };
  }
  return submitClip(pool, p, { ...st, attempt: st.attempt + 1, tries: 0, prompt: `${st.prompt} ${retryHint(c)}` });
}

/** Seconds + routing for a shot. */
export async function clipPlan(pool: Pool, p: ProjectRow, shots: Shot[]): Promise<Omit<ClipState, "genId" | "status">[]> {
  const settings = await getCreativeSettings(pool, p.tenant_id);
  const models = await listModels(pool, p.tenant_id);
  const uses = new Map<string, number>();
  for (const s of shots) for (const c of s.cast ?? []) uses.set(c, (uses.get(c) ?? 0) + 1);
  const out: Omit<ClipState, "genId" | "status">[] = [];
  for (const s of shots) {
    if (s.is_end_card || s.is_static_frame) continue;
    const still = (await pool.query<{ output_path: string }>(`SELECT output_path FROM creative_generations WHERE project_id = $1::uuid AND kind = 'still' AND shot_idx = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`, [p.id, s.idx])).rows[0]?.output_path;
    if (!still) continue;
    const maxUse = Math.max(0, ...(s.cast ?? []).map((c) => uses.get(c) ?? 0));
    const job = videoJobFor(p, s, maxUse);
    const engines = routeFor(job, settings.routing);
    const refs: string[] = [];
    if (job === "identity")
      for (const c of s.cast ?? []) {
        const m = models.find((x) => x.id === c);
        for (const u of (m?.refs ?? []).slice(0, 2)) {
          const path = tryGetStoragePathFromUrl(u);
          if (path) refs.push(signedUrl(path, 24 * 3600));
        }
      }
    out.push({
      shotIdx: s.idx,
      engines,
      engineAt: 0,
      tries: 0,
      attempt: 1,
      still,
      refs,
      prompt: [s.motion_prompt, `Camera: ${s.camera_move.replace(/_/g, " ")}, ${s.lens}. Light: ${s.lighting}.`, "Keep the clothes, logo and face exactly as in the first frame. Realistic fabric motion. No text."].join(" "),
      seconds: Math.max(3, Math.ceil(s.duration_s)),
      audio: p.kind === "ugc",
      aspect: "9:16",
    });
  }
  return out;
}

/* ------------------------------------------------------------------ renders */

export async function queueRender(pool: Pool, p: ProjectRow, plan: unknown, opts: { draft: boolean; size: string; upscale4k?: boolean; interpolate?: boolean; html?: string }): Promise<string> {
  return insertGen(pool, p.tenant_id, { projectId: p.id, kind: "render", provider: "hyperframes", size: opts.size, status: "queued", draft: opts.draft, inputs: { plan, engine: "hyperframes", upscale4k: opts.upscale4k ?? false, interpolate: opts.interpolate ?? false, html: opts.html ?? null } });
}

export async function renderState(pool: Pool, genIds: string[]): Promise<{ done: boolean; failed: string | null }> {
  const r = await pool.query<{ status: string; error: string | null }>(`SELECT status, error FROM creative_generations WHERE id = ANY($1::uuid[])`, [genIds]);
  const failed = r.rows.find((x) => x.status === "failed");
  return { done: r.rows.length > 0 && r.rows.every((x) => x.status === "done"), failed: failed ? failed.error ?? "render failed" : null };
}

/** The latest passing still per shot. */
export async function stillsByShot(pool: Pool, projectId: string): Promise<Map<number, string>> {
  const r = await pool.query<{ shot_idx: number; output_path: string }>(
    `SELECT DISTINCT ON (shot_idx) shot_idx, output_path FROM creative_generations WHERE project_id = $1::uuid AND kind = 'still' AND status = 'done' ORDER BY shot_idx, created_at DESC`,
    [projectId],
  );
  return new Map(r.rows.map((x) => [x.shot_idx, x.output_path]));
}
export async function clipsByShot(pool: Pool, projectId: string): Promise<Map<number, { path: string; duration: number }>> {
  const r = await pool.query<{ shot_idx: number; output_path: string; output_meta: { duration?: number } | null }>(
    `SELECT DISTINCT ON (shot_idx) shot_idx, output_path, output_meta FROM creative_generations WHERE project_id = $1::uuid AND kind = 'clip' AND status = 'done' ORDER BY shot_idx, created_at DESC`,
    [projectId],
  );
  return new Map(r.rows.map((x) => [x.shot_idx, { path: x.output_path, duration: x.output_meta?.duration ?? 5 }]));
}
