/**
 * CarbonWMS Creative — making the pieces: try-on stills (model sheet + Product Twin → still per
 * shot, critic, ≤ 2 automatic retries), video clips from approved stills (first-frame strategy,
 * routing + auto-fallback, critic), and queuing renders for the render worker.
 */
import type { Pool } from "pg";
import sharp from "sharp";
import { falKey, getBrand, getCreativeSettings, presetOf, recordSpend, spendGate, PlainError, UGC_LOOK } from "./config";
import { tryGetStoragePathFromUrl } from "@/lib/storageProvider";
import { generateImage, pollVideo, submitVideo, type ImageRef } from "./engines";
import { criticize, MAX_RETRIES, retryHint, type CriticReport } from "./critic";
import { keyframes } from "./media";
import { listModels, modelRefBytes, type CastModel } from "./casting";
import { getTwin, twinRefs } from "./twin";
import { productSignature, shotColourway } from "./product-fix";
import { getFile, putFile, signedUrl, fetchBytes } from "./storage";
import { routeFor, VIDEO_ENGINES, estimateVideoCost, IMAGE_COST, type VideoJob } from "./routing";
import { chosenFalVoice, ensureFalKlingVoice, ensureKlingVoice, FAL_K4, KLING4, klingKey } from "./kling";
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
  shot_list: { shots: Shot[]; music: { mood: string; bpm: number }; captions: string[]; outfit?: string | null } | null;
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

/** The real product for the quality check: the same references the picture model gets (real photos included). */
async function garmentRefs(pool: Pool, tenantId: string, products: string[]): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const g of await twinRefs(pool, tenantId, products, { max: 8 }).catch(() => [])) {
    try {
      out.push(await sharp(g.bytes).resize(768, 768, { fit: "inside" }).jpeg({ quality: 85 }).toBuffer());
    } catch {
      /* skip */
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

export type StillOpts = { quality?: "high" | "medium" | "low"; extra?: string; draft?: boolean; look?: string; kind?: "still" | "still_end"; firstFrame?: Buffer; notWornYet?: boolean; continuity?: Buffer; outfit?: string | null };
export type StillPrep = { prompt0: string; refs: ImageRef[]; quality: "high" | "medium" | "low"; crit: Buffer[]; personRef: Buffer | null; insp: string[]; ugc: boolean; mustShow: string; colourway: string | null; signature: string };

/** Everything a shot's picture needs: the prompt and the reference pictures (used live and by the batch). */
export async function prepareStill(pool: Pool, p: ProjectRow, shot: Shot, opts: StillOpts = {}): Promise<StillPrep> {
  const ugc = p.kind === "ugc";
  const tid = p.tenant_id;
  const brand = await getBrand(pool, tid);
  const preset = presetOf(brand, p.preset);
  const models = await listModels(pool, tid);
  const cast = (shot.cast?.length ? shot.cast : p.cast_ids).map((id) => models.find((m) => m.id === id)).filter((m): m is CastModel => Boolean(m));
  const products = shot.products?.length ? shot.products : p.products;
  const low = opts.quality === "low"; // storyboard thumbnail: one garment reference, no people refs
  // Reference order = what is kept first at the picture model's 16-reference limit (review 2026-11-15: the
  // continuity / first-frame pictures were the first to be dropped): first frame, continuity, garments,
  // then people (fewer photos each when there's a crowd), then the location.
  const head: ImageRef[] = [];
  if (opts.firstFrame) head.push({ name: "first-frame.jpg", bytes: await sharp(opts.firstFrame).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer(), mime: "image/jpeg" });
  if (opts.continuity) head.push({ name: "continuity.jpg", bytes: await sharp(opts.continuity).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer(), mime: "image/jpeg" });
  const garments = await twinRefs(pool, tid, products);
  if (!garments.length && !shot.is_end_card) throw new PlainError("The product twin has no cut-outs yet. Build and confirm the product first.");
  const gRefs = (low ? garments.slice(0, 1) : garments).map((g, i) => ({ name: `garment-${i}-${g.angle}.png`, bytes: g.bytes, mime: "image/png" }));
  const people: ImageRef[] = [];
  const perPerson = cast.length > 2 ? 1 : cast.length > 1 ? 2 : 3;
  for (const m of low ? [] : cast.slice(0, 4)) {
    const b = await modelRefBytes(m, shot.is_end_card ? 0 : perPerson);
    b.forEach((x, i) => people.push({ name: `person-${m.name}-${i}.jpg`, bytes: x, mime: "image/jpeg" }));
  }
  const loc = low || ugc ? null : await locationRef(pool, tid, shot.location);
  const refs: ImageRef[] = [...head, ...gRefs, ...people, ...(loc ? [loc] : [])].slice(0, 16);
  const crit = low ? [] : await garmentRefs(pool, tid, products);
  // The product's signature details (from its real photos) and the colourway of THIS shot (2026-11-15: details
  // drawn loosely; the anchor shot came back black while the rest were white).
  const signature = shot.is_end_card ? "" : (await Promise.all(products.slice(0, 2).map((id) => productSignature(pool, tid, id, p.id).catch(() => "")))).filter(Boolean).join(" ");
  const colors = (await Promise.all(products.slice(0, 1).map((id) => getTwin(pool, tid, id).catch(() => null))))[0]?.facts?.colors ?? [];
  const colourway = shotColourway(Array.isArray(colors) ? (colors as string[]) : [], shot, p.shot_list?.shots ?? []);
  const mustShow = [shot.garment_must_show, colourway ? `Colourway: ${colourway}` : "", signature ? `Signature details (must match exactly): ${signature}` : ""].filter(Boolean).join(". ");
  // The person's own reference, so the critic can fail a shot where the face changed (owner, 2026-11-15).
  const personRef = low || !cast[0] ? null : (await modelRefBytes(cast[0], 1).catch(() => [] as Buffer[]))[0] ?? null;
  const insp = low ? [] : await inspirationHashes(pool, p.inspiration_ad_id);
  const quality = opts.quality ?? "high";
  const he = cast[0]?.gender === "male";
  const prompt0 = [
    shot.still_prompt,
    ugc
      ? `${UGC_LOOK} Camera: phone, ${shot.camera_move === "static" ? "propped up or selfie" : "handheld"}. Light: ${shot.lighting}. Place: ${shot.location}.`
      : `LOOK: ${opts.look || preset.look}. Camera: ${shot.camera_move.replace(/_/g, " ")}, ${shot.lens} lens. Light: ${shot.lighting}. Location: ${shot.location}.`,
    opts.continuity
      ? `CONTINUITY: the continuity reference is another frame of this SAME video. Same person — identical face, hair, skin, makeup and body — same ${opts.notWornYet ? `basics ${he ? "he" : "she"} wears under the piece` : "outfit worn the same way"}, same room, same light and the same phone. Only the pose and framing change.`
      : "",
    opts.outfit ? `OUTFIT (identical in every shot): ${opts.outfit}.` : "",
    opts.firstFrame ? "The first-frame reference is the START of this same moment: keep the place, light, camera position, background and person identical — only what the shot describes has changed." : "",
    cast.length ? `PEOPLE: the person references show ${cast.map((m) => m.name).join(" and ")} — keep each face, skin tone, hair and body EXACTLY.` : "",
    opts.notWornYet
      ? `CLOTHES: the garment references (${garments.map((g) => `${g.title} ${g.angle}`).join(", ")}) are the real CARBON products. In THIS frame the piece is NOT worn yet — it is on the hanger / in the bag / in ${he ? "his" : "her"} hands exactly as the shot says, and it must look EXACTLY like the references (colour, wash, graphic letter-for-letter, hardware). ${he ? "He" : "She"} wears a plain neutral basic (plain white or black tank top or tee) where the piece will go.`
      : `CLOTHES: the garment references (${garments.map((g) => `${g.title} ${g.angle}`).join(", ")}) are the real CARBON products — dress the people in EXACTLY these: same colour and wash, graphic / logo letter-for-letter, stitching, hardware, fit and length. ${shot.garment_must_show}.`,
    garments.some((g) => g.angle === "product photo")
      ? `COLOURWAYS: some product references are the same piece in its other colourways. ${colourway ? `THIS shot's colourway: ${colourway} — use only that one` : "Use ONLY the colourway this shot names"}; the shape, toe, sole, stripes, logo and stitching are identical in every colourway — copy them exactly, never add lines, stripes or panels that the references don't show.`
      : "",
    signature ? `SIGNATURE DETAILS of the product (copy exactly — placement, count, size, colour): ${signature}` : "",
    ugc
      ? "Photoreal frame from a real person's phone video: real skin texture, natural hands, casual and unposed, everyday background with real-life clutter kept tidy. No added text, captions, watermarks or other brands' logos."
      : "Photoreal fashion campaign photo, real skin texture, natural hands. No added text, captions, watermarks or other brands' logos.",
    opts.extra ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return { prompt0, refs, quality, crit, personRef, insp, ugc, mustShow, colourway, signature };
}

/** A new picture for a shot: saved, then (unless it's a cheap thumbnail) run through the quality check. */
export async function judgeStill(
  pool: Pool,
  p: ProjectRow,
  shot: Shot,
  opts: StillOpts,
  prep: StillPrep,
  v: { genId: string; bytes: Buffer; model: string; cost: number },
): Promise<{ path: string; critic: CriticReport | null }> {
  const path = await putFile(`creative/projects/${p.id}/still-${shot.idx}-${v.genId.slice(0, 8)}.png`, v.bytes, "image/png");
  if (prep.quality === "low") {
    await pool.query(`UPDATE creative_generations SET status = 'done', output_path = $2, model = $3, cost_usd = $4, updated_at = now() WHERE id = $1::uuid`, [v.genId, path, v.model, v.cost]);
    return { path, critic: null };
  }
  const frame = await sharp(v.bytes).resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 88 }).toBuffer();
  const c = await criticize(pool, p.tenant_id, { frames: [frame], kind: "still", garmentRefs: prep.crit, shot: { ...shot, garment_must_show: prep.mustShow || shot.garment_must_show }, preset: p.preset, projectId: p.id, inspirationHashes: prep.insp, isHook: shot.idx === 0 && opts.kind !== "still_end", ugc: prep.ugc, notWornYet: opts.notWornYet, personRef: prep.personRef });
  await pool.query(`UPDATE creative_generations SET status = $2, output_path = $3, model = $4, cost_usd = $5, critic = $6::jsonb, updated_at = now() WHERE id = $1::uuid`, [
    v.genId, c.pass ? "done" : "rejected", path, v.model, v.cost, JSON.stringify(c),
  ]);
  return { path, critic: c };
}

export async function newStillGen(pool: Pool, p: ProjectRow, shot: Shot, opts: StillOpts, prep: StillPrep, prompt: string, attempt: number, extra: Record<string, unknown> = {}): Promise<string> {
  return insertGen(pool, p.tenant_id, { projectId: p.id, kind: prep.quality === "low" ? "sample" : opts.kind ?? "still", shotIdx: shot.idx, provider: "openai", prompt, attempt, draft: opts.draft, inputs: { refs: prep.refs.map((r) => r.name), ...extra } });
}

/**
 * One shot's still, critic-gated, at full price right now (the anchor picture, and anything asked for live).
 * Returns the passing generation (or null after the retries). `quality` low = storyboard thumbnails (no critic).
 */
export async function makeStill(pool: Pool, p: ProjectRow, shot: Shot, opts: StillOpts = {}): Promise<{ genId: string; path: string; critic: CriticReport | null } | null> {
  const tid = p.tenant_id;
  const prep = await prepareStill(pool, p, shot, opts);
  const { prompt0, refs, quality } = prep;
  let best: { genId: string; path: string; critic: CriticReport } | null = null;
  for (let attempt = 1; attempt <= (quality === "low" ? 1 : MAX_RETRIES + 1); attempt++) {
    const est = (quality === "low" ? IMAGE_COST.low : quality === "medium" ? IMAGE_COST.medium : IMAGE_COST.high) + refs.length * 0.01 + (quality === "low" ? 0 : 0.02);
    await spendGate(pool, tid, "openai", est);
    const prompt = attempt === 1 ? prompt0 : `${prompt0}\nRETRY — the quality check found: ${retryHint(best!.critic)}`;
    const genId = await newStillGen(pool, p, shot, opts, prep, prompt, attempt);
    try {
      const g = await generateImage({ prompt, refs, size: "1024x1536", quality });
      await recordSpend(pool, tid, { provider: "openai", what: `still shot ${shot.idx + 1} (${p.title})`, cost: g.cost, projectId: p.id, generationId: genId });
      const j = await judgeStill(pool, p, shot, opts, prep, { genId, bytes: g.bytes, model: g.model, cost: g.cost });
      if (!j.critic) return { genId, path: j.path, critic: null };
      if (j.critic.pass) return { genId, path: j.path, critic: j.critic };
      if (!best || j.critic.overall > best.critic.overall) best = { genId, path: j.path, critic: j.critic };
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

/** Owner, 2026-11-15: the Sydney take had her take a silver ring OFF the dress — hardware must never come off. */
export const GARMENT_INTEGRITY = "GARMENT INTEGRITY: every ring, zip, button, buckle, strap, chain, patch and print is sewn on and stays attached exactly where the product shows it — it never comes off, never floats in a hand, never changes shape or count. Hands may touch the FABRIC near a detail, never pull, pinch or hold the hardware away from the garment.";

export type ClipState = { shotIdx: number; genId: string; engines: string[]; engineAt: number; tries: number; attempt: number; still: string; endStill?: string | null; refs: string[]; personRefs?: string[]; voiceId?: string | null; speakerId?: string | null; takeShots?: { idx: number; seconds: number }[]; middleStills?: string[]; prompt: string; seconds: number; audio: boolean; aspect: string; status: "running" | "done" | "failed"; error?: string };

/** Submit one clip (first frame = the approved still). */
export async function submitClip(pool: Pool, p: ProjectRow, st: Omit<ClipState, "genId" | "status"> & { genId?: string }): Promise<ClipState> {
  const engineId = st.engines[st.engineAt];
  const e = VIDEO_ENGINES[engineId];
  // The speaker's fixed voice for THIS engine (Kling direct and fal keep separate voice ids).
  // A cloned voice is made from a text-to-speech sample and sounds robotic (owner, 2026-11-15). A one-take UGC
  // keeps ONE voice by itself, so it uses Kling's own natural voice; the clone stays for multi-clip videos.
  if (st.speakerId && st.takeShots) {
    // One-take UGC: the voice the owner chose for this model in Settings › Models (library voice or their own
    // recording) on fal; otherwise Kling's own natural voice.
    st = { ...st, voiceId: engineId === FAL_K4 ? await chosenFalVoice(pool, p.tenant_id, st.speakerId).catch(() => null) : null };
  } else if (st.speakerId && (e.provider === "kling" || engineId === FAL_K4)) {
    const m = (await listModels(pool, p.tenant_id)).find((x) => x.id === st.speakerId);
    const voiceId = m ? await (e.provider === "kling" ? ensureKlingVoice : ensureFalKlingVoice)(pool, p.tenant_id, m, p.id).catch(() => null) : null;
    st = { ...st, voiceId };
  }
  const cost = estimateVideoCost(engineId, st.seconds, st.audio);
  await spendGate(pool, p.tenant_id, "fal", cost);
  const ref = await submitVideo({ engineId, prompt: st.prompt, imageUrl: signedUrl(st.still, 24 * 3600), endImageUrl: st.endStill ? signedUrl(st.endStill, 24 * 3600) : undefined, referenceUrls: st.refs, personRefUrls: st.personRefs, voiceId: st.voiceId, middleImageUrls: (st.middleStills ?? []).map((x) => signedUrl(x, 24 * 3600)), seconds: st.seconds, aspect: st.aspect as "9:16", audio: st.audio && e.nativeDialogue, negative: "blur, distortion, warped hands, extra fingers, morphing clothes, changing logo, text" });
  const genId = await insertGen(pool, p.tenant_id, { projectId: p.id, kind: "clip", shotIdx: st.shotIdx, provider: e.provider ?? "fal", model: engineId, prompt: st.prompt, attempt: st.attempt, inputs: { ...ref.meta, still: st.still }, status: "running" });
  await pool.query(`UPDATE creative_generations SET external_id = $2, cost_usd = $3 WHERE id = $1::uuid`, [genId, ref.externalId, ref.cost]);
  await recordSpend(pool, p.tenant_id, { provider: "fal", what: `clip shot ${st.shotIdx + 1} (${VIDEO_ENGINES[engineId].label}, ${ref.seconds}s)`, cost: ref.cost, projectId: p.id, generationId: genId });
  return { ...st, genId, status: "running" };
}

/** Poll one clip; on done → R2 + critic (≤ 2 retries); on failure → retry once, then the next engine. */
export async function advanceClip(pool: Pool, p: ProjectRow, st: ClipState, shot: Shot): Promise<ClipState> {
  if (st.status !== "running") return st;
  const g = (await pool.query(`SELECT external_id, inputs, created_at FROM creative_generations WHERE id = $1::uuid`, [st.genId])).rows[0];
  let res = await pollVideo(g.inputs, g.external_id);
  // A clip still "in progress" after 90 minutes is treated as failed (the engines finish in minutes).
  if (res.state === "pending" && Date.now() - new Date(g.created_at).getTime() > 90 * 60_000) res = { state: "failed", error: "The video engine didn't finish within 90 minutes" };
  if (res.state === "pending") return st;
  if (res.state === "failed") {
    await pool.query(`UPDATE creative_generations SET status = 'failed', error = $2, cost_usd = 0, updated_at = now() WHERE id = $1::uuid`, [st.genId, res.error.slice(0, 500)]);
    // fal does not bill a request that returns no video: take its estimate off today's spend, so failed tries
    // don't eat the cap (owner, 2026-11-14: $14.40 "spent" with no clip made).
    await pool.query(`UPDATE creative_spend SET cost_usd = 0, what = left('failed, not billed: ' || what, 200) WHERE generation_id = $1::uuid`, [st.genId]);
    // Auto-fallback: retry once on the same engine, then the next engine in the route. Logged, never asked.
    // A refusal (content policy — e.g. Seedance won't take faces that look like real people) never passes on
    // the same engine, so it goes straight to the next one.
    const refused = /content_policy|likeness|real people|not allowed|safety/i.test(res.error);
    // A one-take clip has no other engine to fall back to, so it gets two more tries on Kling.
    const next = st.tries < (st.takeShots ? 2 : 1) && !refused ? { ...st, tries: st.tries + 1 } : { ...st, tries: 0, engineAt: st.engineAt + 1 };
    if (next.engineAt >= st.engines.length) return { ...st, status: "failed", error: `Every video engine failed for shot ${st.shotIdx + 1}: ${res.error.slice(0, 200)}` };
    return submitClip(pool, p, next);
  }
  const { bytes } = await fetchBytes(res.url!, 300 * 1024 * 1024);
  const path = await putFile(`creative/projects/${p.id}/clip-${st.shotIdx}-${st.genId.slice(0, 8)}.mp4`, bytes, "video/mp4");
  // A take is long: look at many frames (one every ~2.5 s) so a moment like hardware coming off isn't missed.
  const k = await keyframes(bytes, st.takeShots ? 12 : 5, 640);
  // One take: where each shot sits inside it, scaled to the real length — the edit plays it back without a gap.
  const planned = (st.takeShots ?? []).reduce((a, x) => a + x.seconds, 0);
  let at = 0;
  const take = st.takeShots?.map((x) => {
    const dur = planned ? (x.seconds / planned) * k.duration : 0;
    const r = { idx: x.idx, offset: Math.round(at * 1000) / 1000, dur: Math.round(dur * 1000) / 1000 };
    at += dur;
    return r;
  });
  const crit = await garmentRefs(pool, p.tenant_id, shot.products?.length ? shot.products : p.products);
  // A one-take UGC is judged as the whole take: every shot's action in order, not only the first shot's.
  const all = p.shot_list?.shots ?? [];
  const judged = st.takeShots
    ? { ...shot, subject_action: st.takeShots.map((t) => all.find((x) => x.idx === t.idx)?.subject_action).filter(Boolean).join(" → "), garment_must_show: "the product, worn as in the keyframes" }
    : shot;
  const c = await criticize(pool, p.tenant_id, { frames: k.frames, kind: "clip", garmentRefs: crit, shot: judged, preset: p.preset, projectId: p.id, inspirationHashes: await inspirationHashes(pool, p.inspiration_ad_id), isHook: shot.idx === 0 && !st.takeShots, ugc: p.kind === "ugc", notWornYet: Boolean(shot.puts_on) && !st.takeShots });
  // A one-take UGC costs ~$3–5 a take: it is NEVER re-filmed by itself (owner, 2026-11-15: a picky check re-filmed
  // Sydney at $4.55). The take is kept; the check's notes go to the owner, who decides (Film it again).
  const keep = c.pass || Boolean(st.takeShots);
  await pool.query(`UPDATE creative_generations SET status = $2, output_path = $3, output_meta = $4::jsonb, critic = $5::jsonb, updated_at = now() WHERE id = $1::uuid`, [
    st.genId, keep ? "done" : "rejected", path, JSON.stringify({ duration: k.duration, w: k.width, h: k.height, ...(take ? { take } : {}) }), JSON.stringify(c),
  ]);
  if (!c.pass && st.takeShots) {
    await setProject(pool, p.id, { step_note: `The quality check's notes on this take (${c.overall}/10): ${[c.note, ...c.problems.slice(0, 3)].join(" · ")} — if you want it different, change the words or tap Film it again.` });
    return { ...st, status: "done" };
  }
  if (c.pass) return { ...st, status: "done" };
  if (st.attempt > 1) {
    // Video costs real money: one automatic redo at most. Keep the best-scoring clip but say so — the owner decides (it is never shown as passed).
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
    // Video and UGC: every shot but the end card is a real clip of a moving person (owner, 2026-11-15).
    if (s.is_end_card) continue;
    const still = (await pool.query<{ output_path: string }>(`SELECT output_path FROM creative_generations WHERE project_id = $1::uuid AND kind = 'still' AND shot_idx = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`, [p.id, s.idx])).rows[0]?.output_path;
    if (!still) continue;
    const maxUse = Math.max(0, ...(s.cast ?? []).map((c) => uses.get(c) ?? 0));
    const job = videoJobFor(p, s, maxUse);
    // Kling 4.0 direct first when the key is on the server (owner, 2026-11-15); the saved route stays the backup.
    // Kling 4.0 through fal first (owner, 2026-11-15: "switch"), Kling direct as the backup when its key is set,
    // then the saved route.
    const k4 = [...(falKey() ? [FAL_K4] : []), ...(klingKey() ? [KLING4] : [])];
    const engines = [...k4, ...routeFor(job, settings.routing).filter((x) => !k4.includes(x))];
    // The cast member's photos (face + body) — Kling direct keeps the person identical with them.
    const personRefs: string[] = [];
    for (const c of (s.cast ?? []).slice(0, 1)) {
      const m = models.find((x) => x.id === c);
      for (const u of (m?.refs ?? []).slice(0, 2)) {
        const path = tryGetStoragePathFromUrl(u);
        if (path) personRefs.push(signedUrl(path, 24 * 3600));
      }
    }
    // Who speaks: their fixed Kling voice is fetched (or made once) only when the clip is really sent.
    const speakerId = p.kind === "ugc" && s.say ? (s.cast ?? [])[0] ?? null : null;
    const refs: string[] = [];
    if (job === "identity")
      for (const c of s.cast ?? []) {
        const m = models.find((x) => x.id === c);
        for (const u of (m?.refs ?? []).slice(0, 2)) {
          const path = tryGetStoragePathFromUrl(u);
          if (path) refs.push(signedUrl(path, 24 * 3600));
        }
      }
    const endStill = s.end_state && s.puts_on
      ? (await pool.query<{ output_path: string }>(`SELECT output_path FROM creative_generations WHERE project_id = $1::uuid AND kind = 'still_end' AND shot_idx = $2 AND status = 'done' ORDER BY created_at DESC LIMIT 1`, [p.id, s.idx])).rows[0]?.output_path ?? null
      : null;
    const ugc = p.kind === "ugc";
    const who = models.find((m) => m.id === (s.cast ?? [])[0])?.gender === "male" ? "He" : "She";
    const words = s.say ? s.say.split(/\s+/).length : 0;
    out.push({
      shotIdx: s.idx,
      endStill,
      personRefs,
      speakerId,
      engines,
      engineAt: 0,
      tries: 0,
      attempt: 1,
      still,
      refs,
      prompt: [
        s.motion_prompt,
        ugc
          ? `${s.say ? `${who} talks to the phone camera and says: "${s.say}"` : `${who} doesn't talk.`} Filmed on a phone by a real person: ${s.camera_move === "static" ? "the phone is propped up or held selfie-style" : "handheld, a little natural shake"}, natural light, casual and real, not a commercial.`
          : `Camera: ${s.camera_move.replace(/_/g, " ")}, ${s.lens}. Light: ${s.lighting}.`,
        endStill ? `The clip ends exactly on the last frame given: ${s.end_state}. The garment looks exactly like the last frame — no morphing.` : "Keep the clothes, logo and face exactly as in the first frame.",
        "Realistic fabric motion. No text.",
        GARMENT_INTEGRITY,
      ].join(" "),
      seconds: Math.max(3, Math.ceil(s.duration_s), words ? Math.ceil(words / 2.6) + 1 : 0),
      audio: p.kind === "ugc",
      aspect: "9:16",
    });
  }
  // UGC on Kling direct: the whole thing is ONE continuous phone take (owner, 2026-11-15) — the shots' pictures
  // become its keyframes and every line is spoken in order in one voice; the edit cuts it back at the shots.
  if (p.kind === "ugc" && out.length >= 2 && (out[0].engines[0] === FAL_K4 || out[0].engines[0] === KLING4)) {
    const take = out.slice(0, 8);
    const seconds = Math.min(30, take.reduce((a, c) => a + c.seconds, 0));
    const byIdx = new Map(shots.map((x) => [x.idx, x]));
    // He or she, from the cast member (owner, 2026-11-15: Nico's take said "she").
    const speaker = models.find((m) => m.id === (take.find((c) => c.speakerId)?.speakerId ?? p.cast_ids[0]));
    const male = speaker?.gender === "male";
    // Keyframes in order: each shot's picture, and right after the put-on shot its "now wearing it" picture
    // (review 2026-11-15: the take never used it, so a put-on ending finished NOT worn). The take only ENDS on a
    // given frame when that frame is a put-on result; otherwise the last shot's picture is a middle keyframe so
    // its action and line still get their seconds.
    const frames: { still: string; label: string }[] = [];
    const lines: string[] = [];
    for (const c of take) {
      const s = byIdx.get(c.shotIdx)!;
      const startN = frames.length;
      frames.push({ still: c.still, label: "" });
      if (c.endStill) frames.push({ still: c.endStill, label: "" });
      const said = s.say ? ` — ${male ? "he" : "she"} says: "${s.say}"` : "";
      lines.push(`[keyframe ${startN + 1}${c.endStill ? ` → keyframe ${startN + 2} (now wearing it)` : ""}] (~${c.seconds}s): ${s.subject_action}${said}.`);
    }
    const lastIsEnd = Boolean(take[take.length - 1].endStill);
    // At most 7 in-between keyframes (Kling direct's limit; fal takes 8) plus the first and, when there is one, the end.
    const kept = frames.slice(0, Math.min(frames.length, lastIsEnd ? 9 : 8));
    const first = kept[0];
    const endStill = lastIsEnd && kept.length > 1 && kept.length === frames.length ? kept[kept.length - 1].still : null;
    const middle = kept.slice(1, endStill ? -1 : undefined).map((f) => f.still);
    return [
      {
        ...take[0],
        still: first.still,
        engines: take[0].engines.filter((x) => x === FAL_K4 || x === KLING4),
        seconds,
        endStill,
        middleStills: middle,
        takeShots: take.map((c) => ({ idx: c.shotIdx, seconds: c.seconds })),
        speakerId: take.find((c) => c.speakerId)?.speakerId ?? null,
        prompt: [
          `ONE continuous vertical phone video, a single take with no cuts: a real ${male ? "guy filming himself for his" : "woman filming herself for her"} followers, handheld, natural light, real room sound.`,
          `VOICE: a real ${male ? "young man" : "young woman"} casually talking to ${male ? "his" : "her"} own phone — natural conversational English, relaxed pace with tiny natural pauses, little breaths, a smile in the voice, slightly informal, words a bit run together like real speech. NOT a voice-over, NOT an announcer, NOT text-to-speech, NOT an ad read. Lips match every word.`,
          `Keyframe 1 is the first frame; the rest come in order${endStill ? " and the last one is the final frame" : ""}. What happens, in order:`,
          ...lines,
          "Move naturally from each keyframe to the next. Keep the clothes, face and room exactly as in the keyframes. Realistic fabric motion. No text on screen.",
          GARMENT_INTEGRITY,
        ].join("\n"),
      },
    ];
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
export async function clipsByShot(pool: Pool, projectId: string): Promise<Map<number, { path: string; duration: number; offset?: number }>> {
  const r = await pool.query<{ shot_idx: number; output_path: string; output_meta: { duration?: number; take?: { idx: number; offset: number; dur: number }[] } | null }>(
    `SELECT shot_idx, output_path, output_meta FROM creative_generations WHERE project_id = $1::uuid AND kind = 'clip' AND status = 'done' ORDER BY created_at DESC`,
    [projectId],
  );
  // Newest first, and a shot already covered is never overwritten — so the NEWEST take wins over any older one.
  const out = new Map<number, { path: string; duration: number; offset?: number }>();
  for (const x of r.rows) {
    // One continuous take covers several shots: each shot gets its slice (offset + length) of the same file.
    if (x.output_meta?.take?.length) {
      if (x.output_meta.take.some((t) => out.has(t.idx))) continue;
      for (const t of x.output_meta.take) out.set(t.idx, { path: x.output_path, duration: t.dur, offset: t.offset });
    } else if (!out.has(x.shot_idx)) out.set(x.shot_idx, { path: x.output_path, duration: x.output_meta?.duration ?? 5 });
  }
  return out;
}
