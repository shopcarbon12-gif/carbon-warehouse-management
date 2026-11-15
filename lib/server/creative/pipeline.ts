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
import { enqueue, openJob, type JobHandler } from "./jobs";
import { autoCast, listModels } from "./casting";
import { buildBrief, pitchConcepts, writeShotList, type Concept, type Modifier, type Shot } from "./director";
import { getTwin } from "./twin";
import { advanceClip, clipPlan, clipsByShot, judgeStill, loadProject, makeStill, newStillGen, prepareStill, queueRender, renderState, setProject, stillsByShot, submitClip, STILL_COST, type ClipState, type ProjectRow } from "./produce";
import { buildEditPlan, type EditPlan } from "./editor";
import { listAudio, pickTrack, sfxFor, sfxIndex, type Track } from "./audio";
import { composeStatic, STATIC_SIZES } from "./statics";
import { getFile, putFile, signedUrl, WMS_BASE } from "./storage";
import { captionCards, writeUgcCaptions, writeUgcScript, type UgcScript } from "./ugc";
import { animatedHtml, type AnimatedTemplate } from "./animated";
import { collectImageBatch, speak, submitImageEditBatch, type ImageRef } from "./engines";
import { MAX_RETRIES, retryHint, type CriticReport } from "./critic";
import { IMAGE_COST } from "./routing";
import { notifyCreative } from "./notify";
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
  if (v.ideaId) await pool.query(`UPDATE creative_ideas SET status = 'made' WHERE id = $1::uuid AND tenant_id = $2::uuid`, [v.ideaId, tenantId]);
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
    if (t.status === "building" || t.status === "new") {
      // A build that died (its job failed) left the twin on "building" forever: start it again (once at a time).
      const open = await pool.query(`SELECT 1 FROM creative_jobs WHERE tenant_id = $1::uuid AND kind = 'twin_build' AND payload->>'productId' = $2 AND status IN ('queued','running','waiting')`, [p.tenant_id, id]);
      if (!open.rows[0]) {
        const fails = await pool.query<{ n: string; error: string | null }>(
          `SELECT count(*)::text AS n, max(error) AS error FROM creative_jobs WHERE tenant_id = $1::uuid AND kind = 'twin_build' AND payload->>'productId' = $2 AND status = 'failed' AND created_at > now() - interval '1 day'`,
          [p.tenant_id, id],
        );
        if (Number(fails.rows[0]?.n ?? 0) >= 3) throw new PlainError(`The product twin for "${t.title}" failed 3 times today (${(fails.rows[0]?.error ?? "").slice(0, 160)}). Upload a clear flat-lay or hanger photo on the product card, then try again tomorrow.`);
        await enqueue(pool, p.tenant_id, "twin_build", { productId: id }, { requestedBy: by, progress: "Building the product twin (again)" });
      }
      return { ready: false, waiting: "Building the product twin" };
    }
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
  // UGC: no storyboard sketches (owner, 2026-11-15) — the concept text is enough; the shots are the real preview.
  if (p.kind !== "ugc") await enqueue(pool, p.tenant_id, "concept_thumbs", {}, { projectId: p.id, requestedBy: job.requested_by, progress: "Drawing cheap storyboard thumbnails" });
  return { status: "done", progress: "3 concepts ready — pick one" };
};

/** How many pictures are drawn at once — OpenAI's image rate limit is the ceiling. */
const STILL_PARALLEL = Number(process.env.CREATIVE_STILL_PARALLEL || 5);
const THUMB_PARALLEL = Number(process.env.CREATIVE_THUMB_PARALLEL || 6);

/**
 * Run fn over items, at most `limit` at a time. The first error stops new items from starting, lets the
 * ones already running finish (they are paid for), then is thrown — the same outcome as the old one-by-one loop.
 */
async function inParallel<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let firstError: unknown = null;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && firstError === null) {
      try {
        await fn(items[next++]);
      } catch (e) {
        firstError ??= e;
      }
    }
  });
  await Promise.all(lanes);
  if (firstError !== null) throw firstError;
}

/** Cheap storyboard thumbnails (low quality, no critic). */
export const conceptThumbs: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  type Frame = Concept["storyboard"][number] & { thumb?: string };
  const concepts = (p.concepts ?? []) as (Omit<Concept, "storyboard"> & { storyboard: Frame[] })[];
  const brand = await getBrand(pool, p.tenant_id);
  const preset = presetOf(brand, p.preset);
  // All thumbnails at the same time (owner, 2026-11-14), 4 cheap frames per concept.
  const jobs = concepts.flatMap((c, ci) => c.storyboard.map((f, fi) => ({ c, ci, f, fi })).filter(({ f, fi }) => !f.thumb && fi < 4));
  let drawn = 0;
  await setProgress(`Drawing ${jobs.length} storyboard thumbnails at the same time`);
  await inParallel(jobs, THUMB_PARALLEL, async ({ c, ci, f, fi }) => {
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
      drawn++;
      await setProject(pool, p.id, { concepts });
      await setProgress(`Storyboard thumbnails: ${drawn} of ${jobs.length} done`);
  });
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
    script = await writeUgcScript(pool, p.tenant_id, { facts, persona: cast[0]?.personality ?? "calm, confident streetwear creator", preset: p.preset, concept, projectId: p.id, ctx: { person: cast[0] ? { name: cast[0].name, gender: cast[0].gender, personality: cast[0].personality } : null } });
  }
  await setProgress("Writing the pro shot list");
  const sl = await writeShotList(pool, p.tenant_id, brief, script ? { ...concept, edit_recipe: `${concept.edit_recipe}. Creator lines in order: ${[script.hook, ...script.lines.map((l) => l.say), script.cta].join(" / ")}` } : concept, p.id);
  // Only ONE shot may be the put-on moment; end_state anywhere else is ignored (owner, 2026-11-15: every shot
  // had an end_state, so every picture showed the dress on a hanger over random clothes).
  const change = sl.shots.findIndex((x) => x.puts_on && x.end_state && !x.is_end_card);
  sl.shots.forEach((x, i) => {
    if (i !== change) {
      x.end_state = null;
      x.puts_on = false;
    }
  });
  // Keep cast / products inside what the project has.
  for (const s of sl.shots) {
    // Video + UGC: every shot but the end card becomes a real clip (owner, 2026-11-15: "a real video of a human").
    if ((p.kind === "video" || p.kind === "ugc") && !s.is_end_card) s.is_static_frame = false;
    if (p.kind === "ugc" && !s.is_end_card) {
      // A phone: no dollies, orbits or macro lenses.
      if (!["static", "handheld_follow", "push_in"].includes(s.camera_move)) s.camera_move = "handheld_follow";
      s.lens = "24mm";
      s.text_overlay = null; // UGC: subtitles of what she says only, no ad titles (owner, 2026-11-15)
    } else if (p.kind !== "ugc") {
      s.say = null;
    }
    s.cast = (s.cast ?? []).filter((c) => p.cast_ids.includes(c));
    if (!s.cast.length && !s.is_end_card && p.cast_ids.length) s.cast = [p.cast_ids[0]];
    s.products = (s.products ?? []).filter((x) => p.products.includes(x));
    if (!s.products.length) s.products = p.products.slice(0, 2);
  }
  let captionOptions = sl.captions;
  if (p.kind === "ugc" && script) {
    // What they say = the script the owner sees in "What they say", word for word, spread over the shots in order
    // (review 2026-11-15: the shot-list AI could reword or drop lines). Post captions in the same natural voice.
    const said = [script.hook, ...script.lines.map((l) => l.say), script.cta].filter(Boolean);
    const talk = sl.shots.filter((x) => !x.is_end_card);
    talk.forEach((x, i) => {
      const from = Math.floor((i * said.length) / talk.length);
      const to = Math.floor(((i + 1) * said.length) / talk.length);
      x.say = said.slice(from, to).join(" ") || null;
    });
    const facts = await Promise.all(p.products.map(async (id) => (await getTwin(pool, p.tenant_id, id))?.facts ?? {}));
    captionOptions = (await writeUgcCaptions(pool, p.tenant_id, { script, facts, projectId: p.id }).catch(() => null)) ?? sl.captions;
  }
  await setProject(pool, p.id, { concept_idx: conceptIdx, shot_list: sl, script, status: "shots", captions: { options: captionOptions, hashtags: hashtagsFor(p, brief.lane) } });
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

/** Shot pictures go through the OpenAI Batch (half price) unless CREATIVE_STILLS_LIVE=1 (owner, 2026-11-15). */
const STILLS_LIVE = process.env.CREATIVE_STILLS_LIVE === "1";
type StillTask = { idx: number; kind: "still" | "still_end"; attempt: number; hint?: string | null };
type StillsState = { shots?: number[]; extra?: string; batchId?: string; tasks?: StillTask[]; failed?: number[]; round?: number; started?: string; batchFails?: number };

/** Continuity: the anchor shot (first shot where the piece is worn) and which shots show it not worn yet. */
function continuityOf(shots: Shot[]) {
  const change = shots.find((x) => x.puts_on && x.end_state);
  const notWorn = (x: Shot) => (change ? x.idx <= change.idx : false);
  const anchorShot = shots.find((x) => !x.is_end_card && !notWorn(x)) ?? shots.find((x) => !x.is_end_card);
  return { notWorn, anchorShot };
}

/**
 * The put-on shot's LAST frame: its own scene (now wearing it) — not the shot's still_prompt, which by design
 * describes the moment BEFORE (on the hanger), so end frames came back on the hanger (review 2026-11-15).
 */
function endShot(s: Shot): Shot {
  const after = s.end_state ?? s.subject_action;
  return {
    ...s,
    subject_action: after,
    still_prompt: `The LAST moment of this shot: ${after}. Same place, light, camera position, phone and person as the first frame — the piece is now WORN exactly as the product references.`,
    garment_must_show: `${s.garment_must_show}. Now worn: ${after}`,
  };
}

/** The shot + options for one picture (a still, or the last frame of the put-on shot). */
async function stillTaskInput(pool: Pool, p: ProjectRow, shots: Shot[], t: StillTask, extra: string | undefined, anchor: Buffer | null) {
  const s = shots.find((x) => x.idx === t.idx)!;
  const { notWorn } = continuityOf(shots);
  const outfit = p.shot_list?.outfit ?? null;
  if (t.kind === "still_end") {
    const firstPath = (await stillsByShot(pool, p.id)).get(s.idx);
    const firstFrame = firstPath ? (await getFile(firstPath)).bytes : undefined;
    return { shot: endShot(s), opts: { extra, kind: "still_end" as const, firstFrame, continuity: anchor ?? undefined, outfit } };
  }
  return { shot: s, opts: { extra, notWornYet: notWorn(s), continuity: anchor ?? undefined, outfit } };
}

async function anchorBytes(pool: Pool, p: ProjectRow, shots: Shot[]): Promise<Buffer | null> {
  const { anchorShot } = continuityOf(shots);
  const path = anchorShot ? (await stillsByShot(pool, p.id)).get(anchorShot.idx) : undefined;
  return path ? (await getFile(path)).bytes : null;
}

async function finishStills(pool: Pool, p: ProjectRow, requestedBy: string | null, failed: number[]) {
  failed = [...new Set(failed)].sort((a, b) => a - b);
  await setProject(pool, p.id, { status: "stills", step_note: failed.length ? `Shot${failed.length > 1 ? "s" : ""} ${failed.join(", ")} didn't pass the quality check after 3 tries — they are left out. Ask for a change or try again.` : null });
  await enqueue(pool, p.tenant_id, "project_draft", {}, { projectId: p.id, requestedBy, progress: p.kind === "static" ? "Laying out the statics" : "Cutting the draft (free)" });
  await notifyCreative(pool, p.tenant_id, {
    title: `Creative · ${p.title || "your creative"}: pictures ready`,
    body: failed.length ? `Ready — shot${failed.length > 1 ? "s" : ""} ${failed.join(", ")} didn't pass the quality check. Tap to look.` : "Every shot passed the quality check. Tap to look and make the video.",
    url: `/creative/create?project=${p.id}`,
    tag: `creative-${p.id}-stills`,
  });
  return { status: "done" as const, progress: failed.length ? `${failed.length} still(s) failed the critic` : "All stills passed the critic" };
}

async function submitStillBatch(pool: Pool, p: ProjectRow, shots: Shot[], tasks: StillTask[], st: StillsState, setProgress: (s: string) => Promise<void>) {
  const anchor = await anchorBytes(pool, p, shots);
  const lines: { customId: string; prompt: string; refs: ImageRef[]; quality: "high" }[] = [];
  let est = 0;
  for (const t of tasks) {
    const { shot, opts } = await stillTaskInput(pool, p, shots, t, st.extra, anchor);
    const prep = await prepareStill(pool, p, shot, opts);
    lines.push({ customId: `${t.idx}|${t.kind}|${t.attempt}`, prompt: t.hint ? `${prep.prompt0}\nRETRY — the quality check found: ${t.hint}` : prep.prompt0, refs: prep.refs, quality: "high" });
    est += (IMAGE_COST.high + prep.refs.length * 0.01) * 0.5 + 0.02;
  }
  await spendGate(pool, p.tenant_id, "openai", est);
  await setProgress(`Sending ${lines.length} picture${lines.length === 1 ? "" : "s"} to the OpenAI batch (half price)`);
  const { batchId } = await submitImageEditBatch(lines, { purpose: "creative_stills", project: p.id });
  const round = (st.round ?? 0) + 1;
  return {
    status: "waiting" as const,
    afterSeconds: 120,
    payload: { ...st, batchId, tasks, round, started: new Date().toISOString() },
    progress: `${lines.length} picture${lines.length === 1 ? "" : "s"} in the OpenAI batch (half price${round > 1 ? `, redraw round ${round}` : ""}) — you can leave; a desktop alert comes when they're ready`,
  };
}

export const projectStills: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const shots = p.shot_list?.shots ?? [];
  const st = job.payload as StillsState;
  const { notWorn, anchorShot } = continuityOf(shots);

  // ---- later runs: collect the batch, check every picture, redraw what failed in the next batch
  if (st.batchId && !STILLS_LIVE) {
    const out = await collectImageBatch(st.batchId);
    if (out.state === "pending") return { status: "waiting", afterSeconds: 120, progress: `Pictures in the OpenAI batch (half price) — ${out.status}. You can leave; a desktop alert comes when they're ready.` };
    if (out.state === "failed") {
      // Send the same pictures again once (a dead batch can't be read back); after that, the owner decides.
      if ((st.batchFails ?? 0) < 1 && st.tasks?.length) return submitStillBatch(pool, p, shots, st.tasks, { ...st, batchId: undefined, batchFails: (st.batchFails ?? 0) + 1 }, setProgress);
      throw new PlainError(`The OpenAI batch did not finish (${out.error}). Tap Try again.`);
    }
    const anchor = await anchorBytes(pool, p, shots);
    const failed = [...(st.failed ?? [])];
    const next: StillTask[] = [];
    let n = 0;
    // Pictures of this batch already saved + checked (a Try again after a pause must not count them twice).
    const seen = await pool.query<{ shot_idx: number; kind: string; attempt: number; status: string; critic: CriticReport | null }>(
      `SELECT shot_idx, kind, attempt, status, critic FROM creative_generations WHERE project_id = $1::uuid AND inputs->>'batch' = $2`,
      [p.id, st.batchId],
    );
    for (const t of st.tasks ?? []) {
      const r = out.results.find((x) => x.customId === `${t.idx}|${t.kind}|${t.attempt}`);
      await setProgress(`Checking the batch pictures: ${++n} of ${st.tasks?.length ?? 0}`);
      const retry = (hint: string) => (t.attempt <= MAX_RETRIES ? next.push({ ...t, attempt: t.attempt + 1, hint }) : failed.push(t.idx + 1));
      const done = seen.rows.find((x) => x.shot_idx === t.idx && x.kind === t.kind && x.attempt === t.attempt);
      if (done) {
        const s0 = shots.find((x) => x.idx === t.idx);
        if (done.status === "done") {
          if (t.kind === "still" && s0?.puts_on && s0.end_state) next.push({ idx: t.idx, kind: "still_end", attempt: 1 });
        } else retry(done.critic ? retryHint(done.critic) : "try again");
        continue;
      }
      const { shot, opts } = await stillTaskInput(pool, p, shots, t, st.extra, anchor);
      const prep = await prepareStill(pool, p, shot, opts);
      if (!r?.bytes) {
        retry(`The picture was blocked or missing (${r?.error ?? "no result"}). Keep it clearly fashion, fully clothed, natural pose.`);
        continue;
      }
      const genId = await newStillGen(pool, p, shot, opts, prep, prep.prompt0, t.attempt, { batch: st.batchId });
      const cost = (IMAGE_COST.high + prep.refs.length * 0.01) * 0.5;
      await recordSpend(pool, p.tenant_id, { provider: "openai", what: `still shot ${t.idx + 1}, batch (${p.title})`, cost, projectId: p.id, generationId: genId });
      const j = await judgeStill(pool, p, shot, opts, prep, { genId, bytes: r.bytes, model: "batch", cost });
      if (j.critic?.pass) {
        const s = shots.find((x) => x.idx === t.idx);
        if (t.kind === "still" && s?.puts_on && s.end_state) next.push({ idx: t.idx, kind: "still_end", attempt: 1 });
      } else retry(j.critic ? retryHint(j.critic) : "try again");
    }
    if (next.length) return submitStillBatch(pool, p, shots, next, { ...st, failed }, setProgress);
    return finishStills(pool, p, job.requested_by, failed);
  }

  // ---- first run
  const have = await stillsByShot(pool, p.id);
  const only = st.shots;
  // A put-on shot whose first picture exists and only its "now wearing it" frame is missing: draw just that frame.
  const ends = new Set(
    (await pool.query<{ shot_idx: number }>(`SELECT DISTINCT shot_idx FROM creative_generations WHERE project_id = $1::uuid AND kind = 'still_end' AND status = 'done'`, [p.id])).rows.map((r) => r.shot_idx),
  );
  const endOnly = only ? shots.filter((s) => only.includes(s.idx) && have.has(s.idx) && s.puts_on && s.end_state && !ends.has(s.idx)) : [];
  const todo = shots.filter((s) => !s.is_end_card && !(have.has(s.idx) && !only?.includes(s.idx)) && (!only || only.includes(s.idx)) && !endOnly.some((e) => e.idx === s.idx));
  const failed: number[] = [];
  const extra = st.extra;
  // The ANCHOR picture is drawn first, right now (every other shot copies its face, outfit and room).
  let anchor: Buffer | null = null;
  const anchorPath = anchorShot ? have.get(anchorShot.idx) : undefined;
  if (anchorShot && anchorPath && !todo.some((x) => x.idx === anchorShot.idx)) anchor = (await getFile(anchorPath)).bytes;
  if (anchorShot && todo.some((x) => x.idx === anchorShot.idx)) {
    await setProgress(`Drawing the anchor picture first (shot ${anchorShot.idx + 1}) — every other shot copies its face, outfit and room`);
    const r = await makeStill(pool, p, anchorShot, { extra, outfit: p.shot_list?.outfit ?? null, notWornYet: notWorn(anchorShot) });
    if (r) anchor = (await getFile(r.path)).bytes;
    else failed.push(anchorShot.idx + 1);
  }
  const rest = todo.filter((x) => x.idx !== anchorShot?.idx);
  // The anchor IS the put-on shot (a one-shot "off the hanger"): its "now wearing it" frame still has to be drawn.
  const anchorEnd = anchorShot && anchor && anchorShot.puts_on && anchorShot.end_state && todo.some((x) => x.idx === anchorShot.idx);
  if (!STILLS_LIVE) {
    const tasks: StillTask[] = [...(anchorEnd ? [{ idx: anchorShot!.idx, kind: "still_end" as const, attempt: 1 }] : []), ...endOnly.map((s) => ({ idx: s.idx, kind: "still_end" as const, attempt: 1 })), ...rest.map((s) => ({ idx: s.idx, kind: "still" as const, attempt: 1 }))];
    if (!tasks.length) return finishStills(pool, p, job.requested_by, failed);
    return submitStillBatch(pool, p, shots, tasks, { ...st, failed, round: 0 }, setProgress);
  }
  // Live (CREATIVE_STILLS_LIVE=1): all at the same time at full price.
  let finished = 0;
  await inParallel(rest, STILL_PARALLEL, async (s) => {
    const r = await makeStill(pool, p, s, { extra, notWornYet: notWorn(s), continuity: anchor ?? undefined, outfit: p.shot_list?.outfit ?? null });
    if (!r) failed.push(s.idx + 1);
    else if (s.end_state && s.puts_on) {
      await setProgress(`Shot ${s.idx + 1}: drawing the last frame (${s.end_state.slice(0, 60)})`);
      const first = (await getFile(r.path)).bytes;
      const end = await makeStill(pool, p, endShot(s), { extra, kind: "still_end", firstFrame: first, continuity: anchor ?? undefined, outfit: p.shot_list?.outfit ?? null });
      if (!end) failed.push(s.idx + 1);
    }
    finished++;
    await setProgress(`Drawing the other stills at the same time: ${finished} of ${rest.length} done`);
  });
  return finishStills(pool, p, job.requested_by, failed);
};

/**
 * ugc_rescript: a new natural script for a UGC, keeping its pictures (owner, 2026-11-15: "she shouldn't talk
 * like a walking advertisement"). The lines go onto the shots in order; the old take is set aside so
 * Make the video films it again with the new words.
 */
export const ugcRescript: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  if (p.kind !== "ugc" || !p.shot_list) return { status: "done", progress: "Not a UGC with shots" };
  await setProgress("Rewriting what they say — natural, not an ad");
  const text = await rewriteScript(pool, p);
  return { status: "done", progress: `New words: ${text.slice(0, 120)}` };
};

/* ---- "What they say" (owner, 2026-11-15: see it, edit it by hand, or tap Rewrite for another version) ---- */

export const scriptText = (s: UgcScript | null | undefined) => (s ? [s.hook, ...s.lines.map((l) => l.say), s.cta].filter(Boolean).join(" ") : "");

/** Everything a rewrite should know: the product facts, what the camera sees in each shot, who is talking. */
async function scriptInputs(pool: Pool, p: ProjectRow) {
  const models = await listModels(pool, p.tenant_id);
  const cast = models.find((m) => m.id === p.cast_ids[0]);
  const facts = await Promise.all(p.products.map(async (id) => (await getTwin(pool, p.tenant_id, id))?.facts ?? {}));
  const concept = ((p.concepts ?? []) as Concept[])[p.concept_idx ?? 0] ?? null;
  const shots = (p.shot_list?.shots ?? []).filter((x) => !x.is_end_card).map((x, i) => ({ n: i + 1, place: x.location, action: x.subject_action }));
  const versions = (((p.edit_plan ?? {}) as { scriptVersions?: string[] }).scriptVersions ?? []).slice(-6);
  return { cast, facts, concept, shots, versions };
}

/** Put a script onto the project: its lines spread over the shots in order; the version kept in the history. */
async function applyScript(pool: Pool, p: ProjectRow, script: UgcScript, opts: { captions?: string[] | null } = {}) {
  const said = [script.hook, ...script.lines.map((l) => l.say), script.cta].filter(Boolean);
  const sl = p.shot_list!;
  const talk = sl.shots.filter((x) => !x.is_end_card);
  talk.forEach((x, i) => {
    const from = Math.floor((i * said.length) / talk.length);
    const to = Math.floor(((i + 1) * said.length) / talk.length);
    x.say = said.slice(from, to).join(" ") || null;
    x.text_overlay = null;
  });
  const ep = { ...((p.edit_plan ?? {}) as Record<string, unknown>) };
  const text = said.join(" ");
  // A clip / take filmed with the OLD words must not be reused by Make the video (a finished video stays on screen
  // until Film it again).
  if (p.status !== "final" && text !== scriptText(p.script as UgcScript | null))
    await pool.query(`UPDATE creative_generations SET status = 'cancelled' WHERE project_id = $1::uuid AND kind = 'clip' AND status IN ('done','running','rejected')`, [p.id]);
  const versions = ((ep.scriptVersions as string[] | undefined) ?? []).filter((v) => v !== text);
  ep.scriptVersions = [...versions, text].slice(-12);
  delete ep.takeCaptions;
  await setProject(pool, p.id, {
    script,
    shot_list: sl,
    edit_plan: ep,
    step_note: p.status === "final" ? "New words saved — tap Film it again to film them." : null,
    ...(opts.captions ? { captions: { ...((p.captions ?? {}) as Record<string, unknown>), options: opts.captions } } : {}),
  });
  return text;
}

/** Rewrite: a NEW version that reads the product, every shot and the person (and differs from earlier ones). */
export async function rewriteScript(pool: Pool, p: ProjectRow): Promise<string> {
  const v = await scriptInputs(pool, p);
  const script = await writeUgcScript(pool, p.tenant_id, {
    facts: v.facts,
    persona: v.cast?.personality ?? "warm, relaxed, real",
    preset: p.preset,
    concept: v.concept,
    projectId: p.id,
    ctx: { person: v.cast ? { name: v.cast.name, gender: v.cast.gender, personality: v.cast.personality } : null, shots: v.shots, avoid: [...v.versions, scriptText(p.script as UgcScript | null)].filter(Boolean) },
  });
  const captions = await writeUgcCaptions(pool, p.tenant_id, { script, facts: v.facts, projectId: p.id }).catch(() => null);
  return applyScript(pool, p, script, { captions });
}

/** The owner's own words, typed in the box: split into sentences (opener · middle · closing line). */
export async function saveScriptText(pool: Pool, p: ProjectRow, text: string): Promise<string> {
  const parts = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]*\s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [];
  if (!parts.length) throw new PlainError("Write what they say first.");
  const words = (x: string) => x.split(/\s+/).length;
  const hook = parts[0];
  const cta = parts.length > 1 ? parts[parts.length - 1] : "";
  const middle = parts.slice(1, parts.length > 1 ? -1 : undefined);
  const prev = (p.script ?? {}) as Partial<UgcScript>;
  const script: UgcScript = {
    persona: prev.persona ?? "creator",
    hook,
    lines: (middle.length ? middle : [""]).map((say) => ({ say, action: "", seconds: Math.max(1, Math.min(8, Math.ceil(words(say) / 2.6) + 0.5)), fact_used: null })),
    cta,
    banned_check: { invented_reviews: false, invented_stats: false, claims_to_be_customer: false },
  };
  return applyScript(pool, p, script);
}

/** ugc_refresh: natural post captions from the current script, then a free re-cut (real-speech subtitles). */
export const ugcRefresh: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  if (p.kind !== "ugc" || !p.script) return { status: "done", progress: "Nothing to refresh" };
  await setProgress("Writing natural post captions");
  const facts = await Promise.all(p.products.map(async (id) => (await getTwin(pool, p.tenant_id, id))?.facts ?? {}));
  const options = await writeUgcCaptions(pool, p.tenant_id, { script: p.script as UgcScript, facts, projectId: p.id });
  await setProject(pool, p.id, { captions: { ...((p.captions ?? {}) as Record<string, unknown>), options }, step_note: null });
  if (p.status === "final") await enqueue(pool, p.tenant_id, "project_rerender", {}, { projectId: p.id, requestedBy: job.requested_by, progress: "Re-cutting with subtitles from her real voice (free)" });
  return { status: "done", progress: "Natural captions written" };
};

/* ------------------------------------------------------------------ edit plans */

async function assetsFor(pool: Pool, p: ProjectRow, opts: { clips: boolean; noMusic?: boolean; trackId?: string | null }) {
  const brand = await getBrand(pool, p.tenant_id);
  const preset = presetOf(brand, p.preset);
  const stills = await stillsByShot(pool, p.id);
  const clips = opts.clips ? await clipsByShot(pool, p.id) : new Map<number, { path: string; duration: number; offset?: number }>();
  const assets: Record<string, string> = {};
  const media: Record<number, { kind: "video" | "image"; asset: string; duration?: number; audio?: boolean; offset?: number }> = {};
  for (const [idx, path] of stills) {
    const key = `still-${idx}.png`;
    assets[key] = signedUrl(path, 24 * 3600);
    media[idx] = { kind: "image", asset: key };
  }
  for (const [idx, c] of clips) {
    // A shot inside a one-take clip shares the file: one asset per file, the shot plays its own slice.
    const key = c.offset != null ? `take-${c.path.split("/").pop()!.replace(/[^a-zA-Z0-9.-]/g, "_")}` : `clip-${idx}.mp4`;
    assets[key] = signedUrl(c.path, 24 * 3600);
    media[idx] = { kind: "video", asset: key, duration: c.duration, audio: p.kind === "ugc", offset: c.offset };
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

/**
 * Subtitles from what she REALLY says in a one-take clip (word timestamps from OpenAI speech-to-text, ~1¢),
 * 3–4 words a card. Saved on the project so re-cuts don't pay again.
 */
async function takeCaptions(pool: Pool, p: ProjectRow, takePath: string): Promise<{ text: string; at: number; dur: number }[]> {
  const ep = (p.edit_plan ?? {}) as { takeCaptions?: { path: string; cards: { text: string; at: number; dur: number }[] } };
  if (ep.takeCaptions?.path === takePath) return ep.takeCaptions.cards;
  const { openai } = await import("./config");
  const { toFile } = await import("openai");
  const video = (await getFile(takePath)).bytes;
  // Only the sound goes to speech-to-text (the 1080p video is over its 25 MB limit).
  const { FFMPEG, run, withTmp } = await import("./media");
  const { readFile, writeFile } = await import("node:fs/promises");
  const bytes = await withTmp(async (dir: string) => {
    await writeFile(`${dir}/take.mp4`, video);
    await run(FFMPEG, ["-y", "-i", `${dir}/take.mp4`, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", `${dir}/take.mp3`], 60_000);
    return readFile(`${dir}/take.mp3`);
  });
  await spendGate(pool, p.tenant_id, "openai", 0.01);
  const r = (await openai().audio.transcriptions.create({ file: await toFile(bytes, "take.mp3", { type: "audio/mpeg" }), model: "whisper-1", response_format: "verbose_json", timestamp_granularities: ["word"] } as never)) as unknown as { words?: { word: string; start: number; end: number }[]; duration?: number };
  await recordSpend(pool, p.tenant_id, { provider: "openai", what: "subtitles of the UGC take", cost: Math.max(0.001, ((r.duration ?? 20) / 60) * 0.006), projectId: p.id });
  const words = r.words ?? [];
  const cards: { text: string; at: number; dur: number }[] = [];
  for (let i = 0; i < words.length; i += 4) {
    const w = words.slice(i, i + 4);
    // a card ends early at a sentence end, so captions break where she pauses
    const cut = w.findIndex((x) => /[.!?]$/.test(x.word.trim()));
    const chunk = cut >= 0 && cut < w.length - 1 ? w.slice(0, cut + 1) : w;
    if (chunk.length < w.length) i -= w.length - chunk.length;
    cards.push({ text: chunk.map((x) => x.word.trim()).join(" "), at: Math.round(chunk[0].start * 100) / 100, dur: Math.max(0.3, Math.round((chunk[chunk.length - 1].end - chunk[0].start) * 100) / 100) });
  }
  await setProject(pool, p.id, { edit_plan: { ...((await loadProject(pool, p.tenant_id, p.id)).edit_plan ?? {}), takeCaptions: { path: takePath, cards } } });
  return cards;
}

export async function buildPlan(pool: Pool, p: ProjectRow, aspect: string, opts: { clips: boolean; draft: boolean; noMusic?: boolean; trackId?: string | null; voicePath?: string | null; voiceDur?: number }): Promise<{ plan: EditPlan; track: Track | null }> {
  const a = await assetsFor(pool, p, opts);
  const script = p.script as UgcScript | null;
  // One continuous UGC take: played as ONE piece from start to end — never cut up and re-timed (owner, 2026-11-15:
  // the slices replayed the same sentences) — with subtitles from what she actually says.
  const takeShots = (p.shot_list?.shots ?? []).filter((s) => !s.is_end_card && a.media[s.idx]?.offset != null);
  if (p.kind === "ugc" && opts.clips && takeShots.length) {
    const first = takeShots[0];
    const m = a.media[first.idx];
    const total = takeShots.reduce((x, s) => x + (a.media[s.idx]?.duration ?? 0), 0);
    const clipPath = (await clipsByShot(pool, p.id)).get(first.idx)?.path;
    const shots = [{ ...first, duration_s: total, text_overlay: null, transition_in: "hard_cut", is_static_frame: false }, ...(p.shot_list?.shots ?? []).filter((s) => s.is_end_card)];
    const plan = buildEditPlan({
      shots,
      media: { [first.idx]: { kind: "video", asset: m.asset, duration: total, audio: true, offset: 0 } },
      aspect,
      brand: a.brand,
      preset: { ...a.preset, grade: { contrast: 1, saturation: 1, brightness: 0, warmth: 0, grain: 0 } },
      music: a.track ? { asset: "music.audio", beats: a.track.beats?.beats ?? [], bpm: a.track.bpm ?? 120, drop: a.track.beats?.drop ?? null, duration: a.track.duration_s ?? 60 } : null,
      voice: null,
      // No subtitles on a UGC take (owner, 2026-11-15: "remove the subtitles") — a real phone video is just her talking.
      captions: process.env.CREATIVE_UGC_SUBTITLES === "1" && clipPath ? await takeCaptions(pool, p, clipPath).catch(() => (script ? captionCards(script) : [])) : [],
      sfx: {},
      assets: a.assets,
      logoAsset: "logo.png",
      fontAsset: a.fontAsset,
      draft: opts.draft,
    });
    return { plan: ugcMix(p, plan), track: a.track };
  }
  if (opts.voicePath) a.assets["voice.mp3"] = signedUrl(opts.voicePath, 24 * 3600);
  const overrides = (p.edit_plan as { overrides?: { speed?: number; textScale?: number } })?.overrides ?? {};
  const shots = (p.shot_list?.shots ?? []).map((s) => ({ ...s, duration_s: s.duration_s * (overrides.speed ?? 1) }));
  // UGC keeps the phone's own look: no CARBON grade, no film grain (owner, 2026-11-15).
  const preset = p.kind === "ugc" ? { ...a.preset, grade: { contrast: 1, saturation: 1, brightness: 0, warmth: 0, grain: 0 } } : a.preset;
  const plan = buildEditPlan({
    shots,
    media: a.media,
    aspect,
    brand: a.brand,
    preset,
    music: a.track ? { asset: "music.audio", beats: a.track.beats?.beats ?? [], bpm: a.track.bpm ?? 120, drop: a.track.beats?.drop ?? null, duration: a.track.duration_s ?? 60 } : null,
    voice: opts.voicePath ? { asset: "voice.mp3", duration: opts.voiceDur ?? 10 } : null,
    captions: p.kind === "ugc" ? [] : script ? captionCards(script) : [], // no subtitles on UGC (owner, 2026-11-15)
    sfx: a.sfx,
    assets: a.assets,
    logoAsset: "logo.png",
    fontAsset: a.fontAsset,
    draft: opts.draft,
  });
  if (overrides.textScale) plan.textScale = overrides.textScale;
  return { plan: ugcMix(p, plan), track: a.track };
}

/** UGC: the person's voice leads — music stays low under it, on every cut and re-cut (not only the first final). */
function ugcMix(p: ProjectRow, plan: EditPlan): EditPlan {
  if (p.kind === "ugc" && plan.music && (p.shot_list?.shots ?? []).some((x) => x.say)) plan.music = { ...plan.music, volume: 0.18 };
  return plan;
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
  if (p.kind === "video" || p.kind === "ugc") {
    // No slideshow draft of stills (owner, 2026-11-15: "why pay for a draft that doesn't look like the real
    // thing"). The shots are the preview; Make video (or a one-clip test) makes the real thing.
    await setProject(pool, p.id, { status: "draft" });
    return { status: "done", progress: "Shots ready — make the video, or test one clip first" };
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

export const projectFinal: JobHandler = async (pool, job, setProgress, savePayload) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const st = job.payload as { phase?: "clips" | "render"; clips?: ClipState[]; renders?: string[]; upscale4k?: boolean; renderRetries?: number };
  if (p.kind === "static" || p.kind === "animated") {
    await pool.query(`UPDATE creative_generations SET draft = false WHERE project_id = $1::uuid AND kind = 'render' AND status = 'done'`, [p.id]);
    await setProject(pool, p.id, { status: "final" });
    return { status: "done", progress: "Final — ready to post" };
  }
  if (!st.phase) {
    // Shots that already have a passing clip (an earlier approve, a test clip) keep it; clips already SENT by an
    // earlier run of this step (saved below, one by one) are never sent — and paid for — again.
    const have = await clipsByShot(pool, p.id);
    const sent = st.clips ?? [];
    const plan = (await clipPlan(pool, p, p.shot_list?.shots ?? [])).filter((c) => !have.has(c.shotIdx) && !sent.some((x) => x.shotIdx === c.shotIdx));
    if (!plan.length && !have.size && !sent.length) throw new PlainError("No approved stills to animate.");
    // The whole plan must fit under today's video cap before anything is sent.
    const { estimateVideoCost } = await import("./routing");
    await spendGate(pool, p.tenant_id, "fal", plan.reduce((a, c) => a + estimateVideoCost(c.engines[0], c.seconds, c.audio), 0));
    const clips: ClipState[] = [...sent];
    for (const c of plan) {
      await setProgress(`Sending shot ${c.shotIdx + 1} to ${c.engines[0]}`);
      clips.push(await submitClip(pool, p, c));
      await savePayload({ ...st, clips });
    }
    await setProject(pool, p.id, { status: "clips" });
    return { status: "waiting", afterSeconds: 45, payload: { ...st, phase: "clips", clips }, progress: `${clips.length} clip${clips.length === 1 ? "" : "s"} on the video engine` };
  }
  if (st.phase === "clips") {
    const shots = p.shot_list?.shots ?? [];
    const clips: ClipState[] = [...(st.clips ?? [])];
    for (let i = 0; i < clips.length; i++) {
      try {
        clips[i] = await advanceClip(pool, p, clips[i], shots.find((s) => s.idx === clips[i].shotIdx)!);
      } catch (e) {
        // Keep what changed so far (a re-sent clip has a new id) before the error stops this run.
        await savePayload({ ...st, clips });
        throw e;
      }
      await savePayload({ ...st, clips });
    }
    const running = clips.filter((c) => c.status === "running").length;
    if (running) return { status: "waiting", afterSeconds: 30, payload: { ...st, clips }, progress: `${clips.length - running}/${clips.length} clip${clips.length === 1 ? "" : "s"} done — the video engine takes a few minutes` };
    const failed = clips.filter((c) => c.status === "failed");
    if (failed.length && p.kind === "ugc" && clips.every((c) => c.status === "failed")) throw new PlainError(`${failed.map((f) => f.error).join(" · ")} — tap Try again.`);
    if (failed.length) await setProject(pool, p.id, { step_note: `${failed.map((f) => f.error).join(" · ")} — those shots use the still instead.` });
    return finalRenders(pool, p, st, clips);
  }
  const r = await renderState(pool, st.renders ?? []);
  if (r.failed) {
    // One automatic re-render (fresh links), then hand it to the owner with a Try again that rebuilds the edit.
    if ((st.renderRetries ?? 0) < 1) return finalRenders(pool, p, { ...st, renderRetries: (st.renderRetries ?? 0) + 1 }, st.clips ?? []);
    await savePayload({ ...st, phase: "clips", renders: undefined, renderRetries: 0 });
    throw new PlainError(`The final edit failed: ${r.failed.slice(0, 200)} — tap Try again.`);
  }
  if (!r.done) return { status: "waiting", afterSeconds: 15, progress: "Final edit + finishing (about 2 minutes)" };
  await setProject(pool, p.id, { status: "final" });
  await notifyCreative(pool, p.tenant_id, { title: `Creative · ${p.title || "your video"} is ready`, body: "The final video is done — tap to watch it.", url: `/creative/create?project=${p.id}`, tag: `creative-${p.id}-final` });
  return { status: "done", progress: "Final — ready to post" };
};

async function finalRenders(pool: Pool, p: ProjectRow, st: Record<string, unknown> & { upscale4k?: boolean }, clips: ClipState[]) {
  const renders: string[] = [];
  const ep: Record<string, unknown> = { ...(p.edit_plan ?? {}) };
  for (const size of p.sizes.length ? p.sizes : ["9:16"]) {
    const { plan, track } = await buildPlan(pool, p, size, { clips: true, draft: false, trackId: (p.edit_plan as { trackId?: string })?.trackId ?? null, noMusic: (p.edit_plan as { noMusic?: boolean })?.noMusic ?? false });
    ep[`final-${size}`] = plan;
    ep.trackId = track?.id ?? null;
    const slowed = plan.segments.some((s) => s.src.kind === "video" && (s.src.rate ?? 1) < 0.95);
    renders.push(await queueRender(pool, p, plan, { draft: false, size, interpolate: slowed, upscale4k: st.upscale4k }));
  }
  await setProject(pool, p.id, { edit_plan: ep });
  return { status: "waiting" as const, afterSeconds: 20, payload: { ...st, phase: "render", clips, renders }, progress: "Final edit + finishing (about 2 minutes)" };
}

/**
 * One real clip of the first shot (owner, 2026-11-15: see the real thing before paying for all of it).
 * The clip is kept: Make video later skips any shot that already has a passing clip.
 */
export const projectTestClip: JobHandler = async (pool, job, setProgress) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const st = job.payload as { clip?: ClipState };
  const shots = p.shot_list?.shots ?? [];
  if (!st.clip) {
    const have = await clipsByShot(pool, p.id);
    const first = (await clipPlan(pool, p, shots)).find((c) => !have.has(c.shotIdx));
    if (!first) return { status: "done", progress: "The first shot already has a real clip" };
    if (first.takeShots) return { status: "done", progress: "This UGC is one continuous take — Make the video makes it in one go" };
    await setProgress(`Making a test clip of shot ${first.shotIdx + 1} on ${first.engines[0]}`);
    const clip = await submitClip(pool, p, first);
    return { status: "waiting", afterSeconds: 30, payload: { clip }, progress: `Test clip of shot ${first.shotIdx + 1} on the video engine (1–4 min)` };
  }
  const clip = await advanceClip(pool, p, st.clip, shots.find((s) => s.idx === st.clip!.shotIdx)!);
  if (clip.status === "running") return { status: "waiting", afterSeconds: 20, payload: { clip }, progress: `Test clip of shot ${clip.shotIdx + 1} on the video engine` };
  if (clip.status === "failed") throw new PlainError(clip.error ?? "The test clip failed.");
  return { status: "done", progress: `Test clip ready (shot ${clip.shotIdx + 1}) — Make video keeps it and makes the rest` };
};

/** What the one-clip test costs (shown on its button). */
export async function testClipEstimate(pool: Pool, p: ProjectRow): Promise<number | null> {
  if (p.kind !== "video" && p.kind !== "ugc") return null;
  const have = await clipsByShot(pool, p.id);
  const first = (await clipPlan(pool, p, p.shot_list?.shots ?? [])).find((c) => !have.has(c.shotIdx));
  // A one-take UGC is a single clip: Make the video IS the one clip, so there is nothing smaller to test.
  if (!first || first.takeShots) return null;
  const { estimateVideoCost } = await import("./routing");
  return Math.round((estimateVideoCost(first.engines[0], first.seconds, first.audio) + 0.03) * 100) / 100;
}

/** Shots (1-based) with no passing picture yet — a video must not be filmed with a hole in it (owner, 2026-11-15:
 * the sneaker take jumped from the car to the parking lot because the put-on shot was missing). */
export async function missingShots(pool: Pool, p: ProjectRow): Promise<number[]> {
  if (p.kind !== "video" && p.kind !== "ugc") return [];
  const have = await stillsByShot(pool, p.id);
  const ends = new Set(
    (await pool.query<{ shot_idx: number }>(`SELECT DISTINCT shot_idx FROM creative_generations WHERE project_id = $1::uuid AND kind = 'still_end' AND status = 'done'`, [p.id])).rows.map((r) => r.shot_idx),
  );
  return (p.shot_list?.shots ?? []).filter((s) => !s.is_end_card && (!have.has(s.idx) || (s.puts_on && s.end_state && !ends.has(s.idx)))).map((s) => s.idx + 1);
}

/** Owner tapped Approve. */
export async function approveProject(pool: Pool, tenantId: string, id: string, by: string | null, opts: { upscale4k?: boolean } = {}) {
  const p = await loadProject(pool, tenantId, id);
  if (p.status !== "draft") throw new PlainError("Only a finished draft can be approved.");
  const missing = await missingShots(pool, p);
  if (missing.length) throw new PlainError(`Shot${missing.length > 1 ? "s" : ""} ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} missing — tap Redraw missing shots first, so the video doesn't jump.`);
  if (await openJob(pool, id, ["project_test_clip", "project_final", "project_stills"])) throw new PlainError("Still working on this — wait until the current step is done.");
  // Claim the draft atomically BEFORE queueing: a double tap / second tab gets no row and queues nothing
  // (review 2026-11-15: two finals = every clip paid twice).
  const claimed = await pool.query(`UPDATE creative_projects SET status = 'approved', step_note = NULL, updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid AND status = 'draft' RETURNING id`, [id, tenantId]);
  if (!claimed.rows[0]) throw new PlainError("Already on its way.");
  await enqueue(pool, tenantId, "project_final", { upscale4k: opts.upscale4k ?? false }, { projectId: id, requestedBy: by, progress: p.kind === "static" || p.kind === "animated" ? "Finishing" : "Making the real video" });
}

/** Cost preview for the final step (shown on the Approve button). */
export async function finalEstimate(pool: Pool, p: ProjectRow): Promise<number> {
  if (p.kind === "static" || p.kind === "animated") return 0;
  const have = await clipsByShot(pool, p.id);
  const plan = (await clipPlan(pool, p, p.shot_list?.shots ?? [])).filter((c) => !have.has(c.shotIdx));
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
    testClipEstimate: p.status === "draft" ? await testClipEstimate(pool, p).catch(() => null) : null,
    missingShots: ["draft", "stills"].includes(p.status) ? await missingShots(pool, p).catch(() => []) : [],
    // Already sent to Social → Calendar (a reload must not offer a duplicate post as if it were the first).
    posts: (await pool.query<{ id: string; created_at: string }>(`SELECT post_id::text AS id, created_at FROM creative_posts WHERE project_id = $1::uuid ORDER BY created_at DESC`, [id]).catch(() => ({ rows: [] }))).rows,
    scriptText: p.kind === "ugc" ? scriptText(p.script as UgcScript | null) : null,
    scriptVersions: p.kind === "ugc" ? ((((p.edit_plan ?? {}) as { scriptVersions?: string[] }).scriptVersions ?? []).slice(-12)) : [],
  };
}

/** Thumbnails of a still for the UI (small JPEG). */
export async function thumb(bytes: Buffer, w = 480): Promise<Buffer> {
  return sharp(bytes).resize(w, w * 2, { fit: "inside" }).jpeg({ quality: 78 }).toBuffer();
}
