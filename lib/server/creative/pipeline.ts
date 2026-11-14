/**
 * CarbonWMS Creative — the Create flow as jobs (spec §7). Cheap first, expensive only after the
 * owner approves:
 *   concepts  (text, + low-quality storyboard thumbnails)       → owner picks 1 of 3
 *   shots     (pro shot list JSON)                               → stills (critic-gated)
 *   draft     (statics composed / video animatic from the stills + music, rendered free)
 *   ── owner taps Approve ──
 *   final     (video clips on fal.ai, critic-gated, final render + finishing)
 */
import type { Pool } from "pg";
import { getBrand, presetOf, PlainError, recordSpend, spendGate } from "./config";
import { enqueue, type JobHandler } from "./jobs";
import { autoCast, listModels } from "./casting";
import { buildBrief, pitchConcepts, writeShotList, type Concept, type Modifier, type Shot } from "./director";
import { getTwin } from "./twin";
import { advanceClip, clipPlan, clipsByShot, loadProject, makeStill, queueRender, renderState, setProject, stillsByShot, submitClip, STILL_COST, type ClipState, type ProjectRow } from "./produce";
import { buildEditPlan, type EditPlan } from "./editor";
import { listAudio, pickTrack, sfxFor, sfxIndex, type Track } from "./audio";
import { composeStatic, STATIC_SIZES } from "./statics";
import { getFile, putFile, signedUrl, WMS_BASE } from "./storage";
import { captionCards, writeUgcScript, type UgcScript } from "./ugc";
import { animatedHtml, type AnimatedTemplate } from "./animated";
import { speak } from "./engines";
import { listRecipes } from "./recipes";
import sharp from "sharp";

export type CreateInput = {
  kind: "static" | "video" | "ugc" | "animated";
  products: string[];
  cast?: string[] | "auto";
  preset?: string | null;
  inspirationAdId?: string | null;
  title?: string | null;
  campaignId?: string | null;
  role?: string | null;
  ideaId?: string | null;
  sizes?: string[];
  recipe?: string | null;
  template?: AnimatedTemplate | null;
};

export async function createProject(pool: Pool, tenantId: string, v: CreateInput, by: string | null): Promise<string> {
  if (!v.products.length) throw new PlainError("Pick at least one product.");
  const brand = await getBrand(pool, tenantId);
  const sizes = v.sizes?.length ? v.sizes : v.kind === "static" ? ["4:5", "9:16"] : ["9:16"];
  const r = await pool.query<{ id: string }>(
    `INSERT INTO creative_projects (tenant_id, campaign_id, role, title, kind, products, cast_ids, preset, inspiration_ad_id, sizes, idea_id, created_by, status, brief)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11::uuid, $12, 'brief', $13::jsonb) RETURNING id`,
    [tenantId, v.campaignId ?? null, v.role ?? null, v.title ?? "", v.kind, v.products, Array.isArray(v.cast) ? v.cast : [], v.preset || brand.defaultPreset, v.inspirationAdId ?? null, sizes, v.ideaId ?? null, by, JSON.stringify({ recipe: v.recipe ?? null, template: v.template ?? null })],
  );
  const id = r.rows[0].id;
  await enqueue(pool, tenantId, "project_concepts", {}, { projectId: id, requestedBy: by, progress: "Reading the products" });
  if (v.ideaId) await pool.query(`UPDATE creative_ideas SET status = 'made' WHERE id = $1::uuid`, [v.ideaId]);
  return id;
}

async function ensureTwins(pool: Pool, p: ProjectRow, by: string | null): Promise<{ ready: boolean; waiting: string | null }> {
  for (const id of p.products) {
    const t = await getTwin(pool, p.tenant_id, id);
    if (!t) {
      const open = await pool.query(`SELECT 1 FROM creative_jobs WHERE tenant_id = $1::uuid AND kind = 'twin_build' AND payload->>'productId' = $2 AND status IN ('queued','running','waiting')`, [p.tenant_id, id]);
      if (!open.rows[0]) await enqueue(pool, p.tenant_id, "twin_build", { productId: id }, { requestedBy: by, progress: "Building the product twin" });
      return { ready: false, waiting: "Building the product twin (pictures, cut-outs, facts)" };
    }
    if (t.status === "building" || t.status === "new") return { ready: false, waiting: "Building the product twin" };
    if (t.status === "no_images" && !(t.cutouts ?? []).length) throw new PlainError(`"${t.title}" has no pictures in Shopify. Upload a flat-lay or hanger photo on the product card, then try again.`);
    if (t.status === "failed") throw new PlainError(`The product twin for "${t.title}" failed: ${t.error ?? "unknown"}`);
  }
  return { ready: true, waiting: null };
}

async function genderOf(pool: Pool, p: ProjectRow): Promise<string> {
  const t = await getTwin(pool, p.tenant_id, p.products[0]);
  const s = `${t?.facts?.title ?? ""} ${(t?.facts?.tags ?? []).join(" ")} ${(t?.facts?.collections ?? []).join(" ")}`.toLowerCase();
  if (/\b(women|woman|womens|ladies|dress|skirt)\b/.test(s)) return "women";
  if (/\b(men|mens|man)\b/.test(s)) return "men";
  return "unisex";
}

/* ------------------------------------------------------------------ concepts */

export const projectConcepts: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const tw = await ensureTwins(pool, p, job.requested_by);
  if (!tw.ready) return { status: "waiting", afterSeconds: 20, progress: tw.waiting ?? "Waiting" };
  const brief0 = (p.brief ?? {}) as { recipe?: string | null; template?: string | null };
  if (!p.cast_ids.length && p.kind !== "animated") {
    const cast = await autoCast(pool, p.tenant_id, { lane: null, gender: await genderOf(pool, p), count: 1, kind: p.kind });
    await setProject(pool, p.id, { cast_ids: cast.map((c) => c.id) });
    p.cast_ids = cast.map((c) => c.id);
  }
  const models = await listModels(pool, p.tenant_id);
  const cast = p.cast_ids.map((id) => models.find((m) => m.id === id)).filter(Boolean).map((m) => ({ id: m!.id, name: m!.name, gender: m!.gender, look: m!.look, personality: m!.personality }));
  await setProgress("The Creative Director is pitching 3 concepts");
  const brief = await buildBrief(pool, p.tenant_id, { kind: p.kind, products: p.products, preset: p.preset, cast, inspirationAdId: p.inspiration_ad_id });
  const { modifier } = job.payload as { modifier?: Modifier };
  const previous = (p.concepts ?? []) as Concept[];
  let concepts = await pitchConcepts(pool, p.tenant_id, brief, { modifier: modifier ?? null, previous: modifier ? previous : [], projectId: p.id });
  if (brief0.recipe && !modifier) concepts = concepts.map((c, i) => (i === 0 ? { ...c, recipe_key: brief0.recipe! } : c));
  await setProject(pool, p.id, { concepts, concept_idx: null, status: "concepts", step_note: null, brief: { ...brief0, lane: brief.lane, season: brief.season } });
  await enqueue(pool, p.tenant_id, "concept_thumbs", {}, { projectId: p.id, requestedBy: job.requested_by, progress: "Drawing cheap storyboard thumbnails" });
  return { status: "done", progress: "3 concepts ready — pick one" };
};

/** Cheap storyboard thumbnails (low quality, no critic). */
export const conceptThumbs: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  type Frame = Concept["storyboard"][number] & { thumb?: string };
  const concepts = (p.concepts ?? []) as (Omit<Concept, "storyboard"> & { storyboard: Frame[] })[];
  const brand = await getBrand(pool, p.tenant_id);
  const preset = presetOf(brand, p.preset);
  for (const [ci, c] of concepts.entries()) {
    for (const [fi, f] of c.storyboard.entries()) {
      if (f.thumb || fi >= 4) continue; // 4 cheap frames per concept
      await setProgress(`Storyboard ${ci + 1}/3, frame ${fi + 1}`);
      // Each concept is drawn in its OWN look (location, light, palette) and each frame at its own framing,
      // so three concepts don't come out as the same picture (owner, 2026-11-14).
      const look = c.look?.location ? c.look : null;
      const framing = f.framing ?? "medium";
      const lens = framing === "macro" ? "macro" : framing === "close_up" ? "85mm" : framing === "medium" ? "50mm" : framing === "wide" ? "24mm" : "35mm";
      const framingText = { macro: "extreme macro detail, the garment fills the frame, no face", close_up: "tight close-up", medium: "waist-up medium shot", full_body: "full body, head to toe", wide: "wide shot, the person small in the place" }[framing];
      const shot: Shot = {
        idx: 100 + ci * 10 + fi, subject_action: f.shot, camera_move: "static", lens, lighting: look?.light || preset.look.split(",")[0], location: look?.location || preset.name, duration_s: 1, transition_in: "hard_cut",
        garment_must_show: "the product", cast: [], products: p.products, text_overlay: null, is_end_card: false, is_static_frame: true,
        still_prompt: [
          `Storyboard thumbnail for the ad concept "${c.title}" — ${c.idea}`,
          fi === 0 ? `This is the hook frame: ${c.hook.first_1_5s}` : "",
          `FRAME: ${f.shot}. Framing: ${framingText}.`,
          look ? `Place: ${look.location}. Light: ${look.light}. Palette: ${look.palette}.` : "",
        ].filter(Boolean).join("\n"),
        motion_prompt: "", sfx: [],
      };
      const r = await makeStill(pool, p, shot, { quality: "low", look: look ? `${look.light}; ${look.palette}; within the brand's style (${preset.look})` : undefined }).catch(() => null);
      if (r) f.thumb = r.path;
      // save as we go so the cards fill in
      await setProject(pool, p.id, { concepts });
    }
  }
  return { status: "done", progress: "Storyboards ready" };
};

/* ------------------------------------------------------------------ shots + stills */

export const projectShots: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const { conceptIdx } = job.payload as { conceptIdx: number };
  const concept = ((p.concepts ?? []) as Concept[])[conceptIdx];
  if (!concept) throw new PlainError("Pick one of the 3 concepts.");
  for (const id of p.products) {
    const t = await getTwin(pool, p.tenant_id, id);
    if (t && !t.confirmed_at && (t.cutouts ?? []).length) throw new PlainError(`Check the cut-outs of "${t.title}" and tap ✓ first (they are what the AI dresses the models in).`);
  }
  if (p.kind === "animated") {
    await setProject(pool, p.id, { concept_idx: conceptIdx, status: "shots" });
    await enqueue(pool, p.tenant_id, "project_draft", {}, { projectId: p.id, requestedBy: job.requested_by, progress: "Animating (free)" });
    return { status: "done" };
  }
  // Recast if the concept wants more people (crew).
  if (concept.cast_count > p.cast_ids.length) {
    const more = await autoCast(pool, p.tenant_id, { lane: (p.brief as { lane?: string })?.lane ?? null, gender: "unisex", count: concept.cast_count - p.cast_ids.length, kind: p.kind, exclude: p.cast_ids });
    p.cast_ids = [...p.cast_ids, ...more.map((m) => m.id)];
    await setProject(pool, p.id, { cast_ids: p.cast_ids });
  }
  const models = await listModels(pool, p.tenant_id);
  const cast = p.cast_ids.map((id) => models.find((m) => m.id === id)).filter(Boolean).map((m) => ({ id: m!.id, name: m!.name, gender: m!.gender, look: m!.look, personality: m!.personality }));
  const brief = await buildBrief(pool, p.tenant_id, { kind: p.kind, products: p.products, preset: p.preset, cast, inspirationAdId: p.inspiration_ad_id });
  let script: UgcScript | null = null;
  if (p.kind === "ugc") {
    await setProgress("Writing the creator script (facts only)");
    const facts = await Promise.all(p.products.map(async (id) => (await getTwin(pool, p.tenant_id, id))?.facts ?? {}));
    script = await writeUgcScript(pool, p.tenant_id, { facts, persona: cast[0]?.personality ?? "calm, confident streetwear creator", preset: p.preset, concept, projectId: p.id });
  }
  await setProgress("Writing the pro shot list");
  const sl = await writeShotList(pool, p.tenant_id, brief, script ? { ...concept, edit_recipe: `${concept.edit_recipe}. Creator lines in order: ${[script.hook, ...script.lines.map((l) => l.say), script.cta].join(" / ")}` } : concept, p.id);
  // Keep cast / products inside what the project has.
  for (const s of sl.shots) {
    s.cast = (s.cast ?? []).filter((c) => p.cast_ids.includes(c));
    if (!s.cast.length && !s.is_end_card && p.cast_ids.length) s.cast = [p.cast_ids[0]];
    s.products = (s.products ?? []).filter((x) => p.products.includes(x));
    if (!s.products.length) s.products = p.products.slice(0, 2);
  }
  await setProject(pool, p.id, { concept_idx: conceptIdx, shot_list: sl, script, status: "shots", captions: { options: sl.captions, hashtags: hashtagsFor(p, brief.lane) } });
  const n = sl.shots.filter((s) => !s.is_end_card).length;
  await enqueue(pool, p.tenant_id, "project_stills", {}, { projectId: p.id, requestedBy: job.requested_by, progress: `Dressing the models: ${n} stills (≈ $${(n * STILL_COST).toFixed(2)})` });
  return { status: "done", progress: "Shot list ready" };
};

function hashtagsFor(p: ProjectRow, lane: string | null): string[] {
  const base = ["shopcarbon", "carbonorlando", "orlandofashion"];
  const lanes: Record<string, string[]> = {
    streetwear: ["streetwear", "streetstyle", "fitcheck"],
    denim: ["denim", "jeans", "denimstyle"],
    luxury: ["luxuryfashion", "quietluxury", "editorial"],
    evening_going_out: ["nightout", "goingoutoutfit", "eveningwear"],
  };
  return [...base, ...(lanes[lane ?? "streetwear"] ?? lanes.streetwear), ...(p.kind === "ugc" ? ["aigenerated"] : [])];
}

export const projectStills: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const shots = p.shot_list?.shots ?? [];
  const have = await stillsByShot(pool, p.id);
  const only = (job.payload as { shots?: number[] }).shots;
  const failed: number[] = [];
  for (const s of shots) {
    if (s.is_end_card || (have.has(s.idx) && !only?.includes(s.idx))) continue;
    if (only && !only.includes(s.idx)) continue;
    await setProgress(`Still ${s.idx + 1} of ${shots.length}: ${s.subject_action.slice(0, 60)}`);
    const r = await makeStill(pool, p, s, { extra: (job.payload as { extra?: string }).extra });
    if (!r) failed.push(s.idx + 1);
  }
  await setProject(pool, p.id, { status: "stills", step_note: failed.length ? `Shot${failed.length > 1 ? "s" : ""} ${failed.join(", ")} didn't pass the quality check after 3 tries — they are left out. Ask for a change or try again.` : null });
  await enqueue(pool, p.tenant_id, "project_draft", {}, { projectId: p.id, requestedBy: job.requested_by, progress: p.kind === "static" ? "Laying out the statics" : "Cutting the draft (free)" });
  return { status: "done", progress: failed.length ? `${failed.length} still(s) failed the critic` : "All stills passed the critic" };
};

/* ------------------------------------------------------------------ edit plans */

async function assetsFor(pool: Pool, p: ProjectRow, opts: { clips: boolean; noMusic?: boolean; trackId?: string | null }) {
  const brand = await getBrand(pool, p.tenant_id);
  const preset = presetOf(brand, p.preset);
  const stills = await stillsByShot(pool, p.id);
  const clips = opts.clips ? await clipsByShot(pool, p.id) : new Map<number, { path: string; duration: number }>();
  const assets: Record<string, string> = {};
  const media: Record<number, { kind: "video" | "image"; asset: string; duration?: number; audio?: boolean }> = {};
  for (const [idx, path] of stills) {
    const key = `still-${idx}.png`;
    assets[key] = signedUrl(path, 24 * 3600);
    media[idx] = { kind: "image", asset: key };
  }
  for (const [idx, c] of clips) {
    const key = `clip-${idx}.mp4`;
    assets[key] = signedUrl(c.path, 24 * 3600);
    media[idx] = { kind: "video", asset: key, duration: c.duration, audio: p.kind === "ugc" };
  }
  const audio = await listAudio(pool, p.tenant_id);
  let track: Track | null = null;
  if (!opts.noMusic) {
    const want = p.shot_list?.music ?? { mood: brand.editStyle.musicMoods[0], bpm: 122 };
    track = opts.trackId ? audio.find((a) => a.id === opts.trackId) ?? null : pickTrack(audio, want, ((p.edit_plan as { rejectedTracks?: string[] })?.rejectedTracks ?? []));
    if (track) assets["music.audio"] = signedUrl(track.storage_path, 24 * 3600);
  }
  const sfxIdx = sfxIndex(audio);
  const sfx: Record<string, string> = {};
  for (const s of p.shot_list?.shots ?? [])
    for (const n of s.sfx ?? []) {
      const t = sfxFor(n, sfxIdx);
      if (t) {
        const key = `sfx-${t.id.slice(0, 8)}.audio`;
        assets[key] = signedUrl(t.storage_path, 24 * 3600);
        sfx[n.toLowerCase()] = key;
      }
    }
  assets["logo.png"] = `${WMS_BASE}/email/carbon-logo-long-white.png`;
  let fontAsset: string | null = null;
  if (brand.fonts.headlineFile) {
    fontAsset = `headline${brand.fonts.headlineFile.match(/\.(woff2?|ttf|otf)$/i)?.[0] ?? ".woff2"}`;
    assets[fontAsset] = signedUrl(brand.fonts.headlineFile, 24 * 3600);
  }
  return { brand, preset, media, assets, track, sfx, fontAsset };
}

export async function buildPlan(pool: Pool, p: ProjectRow, aspect: string, opts: { clips: boolean; draft: boolean; noMusic?: boolean; trackId?: string | null; voicePath?: string | null; voiceDur?: number }): Promise<{ plan: EditPlan; track: Track | null }> {
  const a = await assetsFor(pool, p, opts);
  const script = p.script as UgcScript | null;
  if (opts.voicePath) a.assets["voice.mp3"] = signedUrl(opts.voicePath, 24 * 3600);
  const overrides = (p.edit_plan as { overrides?: { speed?: number; textScale?: number } })?.overrides ?? {};
  const shots = (p.shot_list?.shots ?? []).map((s) => ({ ...s, duration_s: s.duration_s * (overrides.speed ?? 1) }));
  const plan = buildEditPlan({
    shots,
    media: a.media,
    aspect,
    brand: a.brand,
    preset: a.preset,
    music: a.track ? { asset: "music.audio", beats: a.track.beats?.beats ?? [], bpm: a.track.bpm ?? 120, drop: a.track.beats?.drop ?? null, duration: a.track.duration_s ?? 60 } : null,
    voice: opts.voicePath ? { asset: "voice.mp3", duration: opts.voiceDur ?? 10 } : null,
    captions: script ? captionCards(script) : [],
    sfx: a.sfx,
    assets: a.assets,
    logoAsset: "logo.png",
    fontAsset: a.fontAsset,
    draft: opts.draft,
  });
  if (overrides.textScale) plan.textScale = overrides.textScale;
  return { plan, track: a.track };
}

/** Animated: the template, driven by the Product Twin cut-outs (no paid AI). */
async function animatedPlan(pool: Pool, p: ProjectRow, aspect: string): Promise<{ plan: EditPlan; html: string; track: Track | null }> {
  const a = await assetsFor(pool, p, { clips: false });
  const concept = ((p.concepts ?? []) as Concept[])[p.concept_idx ?? 0];
  const brief = (p.brief ?? {}) as { template?: AnimatedTemplate };
  const recipe = concept?.recipe_key ?? "";
  const template: AnimatedTemplate =
    brief.template ?? (/price/.test(recipe) ? "price_drop" : /three|3_ways/.test(recipe) ? "three_ways" : /countdown|drop/.test(recipe) ? "countdown" : /grid|flatlay/.test(recipe) ? "outfit_grid" : /orbit|spin/.test(recipe) ? "product_spin" : "kinetic_type");
  const images: string[] = [];
  let title = "", price: string | null = null, compareAt: string | null = null;
  for (const id of p.products) {
    const t = await getTwin(pool, p.tenant_id, id);
    if (!t) continue;
    if (!title) {
      title = t.title;
      price = t.facts?.price ? `$${Number(t.facts.price).toFixed(0)}` : null;
      compareAt = t.facts?.compareAt ? `$${Number(t.facts.compareAt).toFixed(0)}` : null;
    }
    for (const c of t.cutouts ?? []) {
      const key = `cut-${images.length}.png`;
      a.assets[key] = signedUrl(c.storage_path, 24 * 3600);
      images.push(key);
    }
  }
  if (!images.length) throw new PlainError("The product twin has no cut-outs yet.");
  const [W, H] = aspect === "4:5" ? [1080, 1350] : aspect === "1:1" ? [1080, 1080] : [1080, 1920];
  const words = (concept?.hook?.text ?? title).split(/\s+/).filter(Boolean).slice(0, 5);
  const musicStart = a.track?.beats?.drop != null ? Math.max(0, a.track.beats.drop - 3) : 0;
  const { html, duration } = animatedHtml(template, {
    title, price, compareAt, words, images, date: null,
    bg: a.brand.colors.ink, ink: "#ffffff", accent: a.brand.colors.accent, headlineAsset: a.fontAsset, logoAsset: "logo.png",
    musicAsset: a.track ? "music.audio" : null, musicStart, width: W, height: H,
  });
  const plan: EditPlan = {
    version: 1, width: W, height: H, fps: 30, duration, bpm: a.track?.bpm ?? null, music: null, voice: null, segments: [], captions: [],
    endCard: { text: "CARBON", sub: "shopcarbon.com", logoAsset: "logo.png", start: duration - 1.6, dur: 1.6 },
    font: { headline: a.brand.fonts.headline, headlineAsset: a.fontAsset, body: a.brand.fonts.body }, colors: { ink: a.brand.colors.ink, paper: a.brand.colors.paper, accent: a.brand.colors.accent },
    grade: { ...a.preset.grade, contrast: 1, saturation: 1, brightness: 0, warmth: 0 }, grain: 0.04, lufs: a.brand.editStyle.export.lufs, safe: { top: 0, bottom: 0, side: 0 }, assets: a.assets,
  };
  return { plan, html, track: a.track };
}

/* ------------------------------------------------------------------ draft */

export const projectDraft: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const st = job.payload as { renders?: string[] };
  if (st.renders?.length) {
    const r = await renderState(pool, st.renders);
    if (r.failed) throw new PlainError(`The draft render failed: ${r.failed.slice(0, 300)}`);
    if (!r.done) return { status: "waiting", afterSeconds: 15, progress: "Rendering the draft on the CarbonWMS server (free)" };
    await setProject(pool, p.id, { status: "draft" });
    return { status: "done", progress: "Draft ready — approve it or ask for changes" };
  }
  if (p.kind === "static") {
    await composeStatics(pool, p, setProgress, true);
    await setProject(pool, p.id, { status: "draft" });
    return { status: "done", progress: "Statics ready — approve them or ask for changes" };
  }
  const renders: string[] = [];
  const editPlans: Record<string, unknown> = { ...(p.edit_plan ?? {}) };
  for (const size of p.sizes.length ? p.sizes : ["9:16"]) {
    if (p.kind === "animated") {
      const a = await animatedPlan(pool, p, size);
      renders.push(await queueRender(pool, p, a.plan, { draft: true, size, html: a.html }));
      editPlans.trackId = a.track?.id ?? null;
      continue;
    }
    let voicePath: string | null = null, voiceDur = 0;
    if (p.kind === "ugc" && p.script) {
      // Draft voice: OpenAI TTS (cents). The final uses the video engine's own dialogue.
      const s = p.script as UgcScript;
      const models = await listModels(pool, p.tenant_id);
      const m = models.find((x) => x.id === p.cast_ids[0]);
      const text = [s.hook, ...s.lines.map((l) => l.say), s.cta].join(" ");
      await spendGate(pool, p.tenant_id, "openai", 0.02);
      const v = await speak(text, m?.voice ?? (m?.gender === "female" ? "coral" : "ash"), `Speak like a real creator talking to their phone: ${m?.personality ?? "relaxed, confident"}. Natural, not salesy.`);
      await recordSpend(pool, p.tenant_id, { provider: "openai", what: "UGC draft voice", cost: v.cost, projectId: p.id });
      voicePath = await putFile(`creative/projects/${p.id}/voice-draft.mp3`, v.bytes, "audio/mpeg");
      voiceDur = s.lines.reduce((a2, l) => a2 + l.seconds, 3.5);
    }
    const { plan, track } = await buildPlan(pool, p, size, { clips: false, draft: true, voicePath, voiceDur, trackId: (p.edit_plan as { trackId?: string })?.trackId ?? null, noMusic: (p.edit_plan as { noMusic?: boolean })?.noMusic });
    editPlans[size] = plan;
    editPlans.trackId = track?.id ?? null;
    renders.push(await queueRender(pool, p, plan, { draft: true, size }));
  }
  await setProject(pool, p.id, { edit_plan: editPlans });
  await setProgress("Rendering the draft (free)");
  return { status: "waiting", afterSeconds: 15, payload: { renders }, progress: "Rendering the draft on the CarbonWMS server (free)" };
};

async function composeStatics(pool: Pool, p: ProjectRow, setProgress: (s: string) => Promise<void>, draft: boolean) {
  const brand = await getBrand(pool, p.tenant_id);
  const stills = await stillsByShot(pool, p.id);
  const shots = (p.shot_list?.shots ?? []).filter((s) => !s.is_end_card && stills.has(s.idx));
  const t = await getTwin(pool, p.tenant_id, p.products[0]);
  const price = t?.facts?.price ? `$${Number(t.facts.price).toFixed(0)}` : null;
  const logo = await fetch(`${WMS_BASE}/email/carbon-logo-long-white.png`).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => (b ? Buffer.from(b) : null)).catch(() => null);
  await pool.query(`UPDATE creative_generations SET status = 'cancelled' WHERE project_id = $1::uuid AND kind = 'render' AND provider = 'satori'`, [p.id]);
  for (const [i, s] of shots.entries()) {
    const still = (await getFile(stills.get(s.idx)!)).bytes;
    for (const size of p.sizes.length ? p.sizes : ["4:5"]) {
      if (!STATIC_SIZES[size]) continue;
      await setProgress(`Laying out slide ${i + 1}/${shots.length} (${size})`);
      const isFirst = i === 0;
      const isLast = i === shots.length - 1;
      const out = await composeStatic(brand, still, size, {
        headline: s.text_overlay ?? (isFirst ? t?.title ?? null : null),
        sub: isLast && shots.length > 1 ? "shopcarbon.com" : null,
        price: isFirst || isLast ? price : null,
        cta: isLast ? "Shop now" : null,
        template: isFirst ? "hook_top" : isLast ? "price_tag" : s.text_overlay ? "minimal" : "none",
      }, isFirst ? logo : null);
      const path = await putFile(`creative/projects/${p.id}/static-${i}-${size.replace(":", "x")}-${Date.now()}.jpg`, out, "image/jpeg");
      await pool.query(
        `INSERT INTO creative_generations (tenant_id, project_id, kind, shot_idx, size, provider, status, output_path, draft) VALUES ($1::uuid, $2::uuid, 'render', $3, $4, 'satori', 'done', $5, $6)`,
        [p.tenant_id, p.id, s.idx, size, path, draft],
      );
    }
  }
}

/* ------------------------------------------------------------------ approve → final */

export const projectFinal: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const st = job.payload as { phase?: "clips" | "render"; clips?: ClipState[]; renders?: string[]; upscale4k?: boolean };
  if (p.kind === "static" || p.kind === "animated") {
    await pool.query(`UPDATE creative_generations SET draft = false WHERE project_id = $1::uuid AND kind = 'render' AND status = 'done'`, [p.id]);
    await setProject(pool, p.id, { status: "final" });
    return { status: "done", progress: "Final — ready to post" };
  }
  if (!st.phase) {
    // Shots that already have a passing clip (an earlier approve, or a chat edit elsewhere) keep it.
    const have = await clipsByShot(pool, p.id);
    const plan = (await clipPlan(pool, p, p.shot_list?.shots ?? [])).filter((c) => !have.has(c.shotIdx));
    if (!plan.length && !have.size) throw new PlainError("No approved stills to animate.");
    const clips: ClipState[] = [];
    for (const c of plan) {
      await setProgress(`Sending shot ${c.shotIdx + 1} to ${c.engines[0]}`);
      clips.push(await submitClip(pool, p, c));
    }
    await setProject(pool, p.id, { status: "clips" });
    return { status: "waiting", afterSeconds: 45, payload: { ...st, phase: "clips", clips }, progress: `${clips.length} clips on the video engines` };
  }
  if (st.phase === "clips") {
    const shots = p.shot_list?.shots ?? [];
    const clips: ClipState[] = [];
    for (const c of st.clips ?? []) clips.push(await advanceClip(pool, p, c, shots.find((s) => s.idx === c.shotIdx)!));
    const running = clips.filter((c) => c.status === "running").length;
    if (running) return { status: "waiting", afterSeconds: 30, payload: { ...st, clips }, progress: `${clips.length - running}/${clips.length} clips done` };
    const failed = clips.filter((c) => c.status === "failed");
    if (failed.length) await setProject(pool, p.id, { step_note: `${failed.map((f) => f.error).join(" · ")} — those shots use the still instead.` });
    const renders: string[] = [];
    const ep: Record<string, unknown> = { ...(p.edit_plan ?? {}) };
    for (const size of p.sizes.length ? p.sizes : ["9:16"]) {
      const { plan, track } = await buildPlan(pool, p, size, { clips: true, draft: false, trackId: (p.edit_plan as { trackId?: string })?.trackId ?? null, noMusic: (p.edit_plan as { noMusic?: boolean })?.noMusic ?? false });
      if (p.kind === "ugc") plan.music = plan.music ? { ...plan.music, volume: 0.18 } : null; // the creator's voice leads
      ep[`final-${size}`] = plan;
      ep.trackId = track?.id ?? null;
      const slowed = plan.segments.some((s) => s.src.kind === "video" && (s.src.rate ?? 1) < 0.95);
      renders.push(await queueRender(pool, p, plan, { draft: false, size, interpolate: slowed, upscale4k: st.upscale4k }));
    }
    await setProject(pool, p.id, { edit_plan: ep });
    return { status: "waiting", afterSeconds: 20, payload: { ...st, phase: "render", clips, renders }, progress: "Final render + finishing (grade, grain, −14 LUFS)" };
  }
  const r = await renderState(pool, st.renders ?? []);
  if (r.failed) throw new PlainError(`The final render failed: ${r.failed.slice(0, 300)}`);
  if (!r.done) return { status: "waiting", afterSeconds: 15, progress: "Final render + finishing" };
  await setProject(pool, p.id, { status: "final" });
  return { status: "done", progress: "Final — ready to post" };
};

/** Owner tapped Approve. */
export async function approveProject(pool: Pool, tenantId: string, id: string, by: string | null, opts: { upscale4k?: boolean } = {}) {
  const p = await loadProject(pool, tenantId, id);
  if (p.status !== "draft") throw new PlainError("Only a finished draft can be approved.");
  await enqueue(pool, tenantId, "project_final", { upscale4k: opts.upscale4k ?? false }, { projectId: id, requestedBy: by, progress: p.kind === "static" || p.kind === "animated" ? "Finishing" : "Making the real video clips" });
  await setProject(pool, id, { status: "approved" });
}

/** Cost preview for the final step (shown on the Approve button). */
export async function finalEstimate(pool: Pool, p: ProjectRow): Promise<number> {
  if (p.kind === "static" || p.kind === "animated") return 0;
  const plan = await clipPlan(pool, p, p.shot_list?.shots ?? []);
  const { estimateVideoCost } = await import("./routing");
  return Math.round(plan.reduce((a, c) => a + estimateVideoCost(c.engines[0], c.seconds, c.audio) * 1.0 + 0.03, 0) * 100) / 100;
}

/* ------------------------------------------------------------------ project view */

export async function projectView(pool: Pool, tenantId: string, id: string) {
  const p = await loadProject(pool, tenantId, id);
  const gens = await pool.query(
    `SELECT id::text, kind, shot_idx, size, provider, model, status, output_path, output_meta, cost_usd, critic, attempt, draft, error, created_at FROM creative_generations WHERE project_id = $1::uuid ORDER BY created_at`,
    [id],
  );
  const jobs = await pool.query(`SELECT id::text, kind, status, progress, error, updated_at FROM creative_jobs WHERE project_id = $1::uuid ORDER BY created_at DESC LIMIT 12`, [id]);
  const spend = await pool.query<{ total: string }>(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM creative_spend WHERE project_id = $1::uuid`, [id]);
  const chat = await pool.query(`SELECT role, text, change, created_at FROM creative_chat WHERE project_id = $1::uuid ORDER BY created_at`, [id]);
  const recipes = await listRecipes(pool, tenantId);
  const models = await listModels(pool, tenantId);
  const twins = await Promise.all(p.products.map((pid) => getTwin(pool, tenantId, pid)));
  return {
    project: p,
    generations: gens.rows,
    jobs: jobs.rows,
    spend: Number(spend.rows[0].total),
    chat: chat.rows,
    recipes: recipes.map((r) => ({ key: r.key, name: r.name })),
    cast: p.cast_ids.map((cid) => models.find((m) => m.id === cid)).filter(Boolean),
    twins,
    finalEstimate: p.status === "draft" ? await finalEstimate(pool, p).catch(() => null) : null,
  };
}

/** Thumbnails of a still for the UI (small JPEG). */
export async function thumb(bytes: Buffer, w = 480): Promise<Buffer> {
  return sharp(bytes).resize(w, w * 2, { fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
}
