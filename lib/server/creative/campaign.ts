/**
 * CarbonWMS Creative — Full Campaign (spec §7.6). One button = the whole drop: 1 hero video
 * (15–25 s), 3 cut-downs (6–10 s), 1 UGC, 4 statics, 1 carousel, 3 stories, 1 animated, captions +
 * hashtags — same cast, locations, grade and type, every size. The owner approves the hero concept
 * once; everything else follows it. Most of the pack re-uses the hero's approved stills and clips
 * (no extra AI cost); only the UGC makes new clips.
 */
import type { Pool } from "pg";
import { PlainError } from "./config";
import { enqueue, type JobHandler } from "./jobs";
import { createProject } from "./pipeline";
import { loadProject, setProject, stillsByShot, clipsByShot, queueRender, renderState, type ProjectRow } from "./produce";
import type { Shot } from "./director";

export const PACK = { cutdowns: 3, ugc: 1, statics: 4, carousel: 1, stories: 3, animated: 1 } as const;

export async function createCampaign(pool: Pool, tenantId: string, v: { name: string; products: string[]; preset?: string | null; cast?: string[] | "auto"; inspirationAdId?: string | null }, by: string | null) {
  if (!v.products.length) throw new PlainError("Pick the product(s) for the drop.");
  const c = await pool.query<{ id: string }>(`INSERT INTO creative_campaigns (tenant_id, name, products, created_by, plan) VALUES ($1::uuid, $2, $3, $4, $5::jsonb) RETURNING id`, [
    tenantId, v.name.slice(0, 120) || "New drop", v.products, by, JSON.stringify({ pack: PACK }),
  ]);
  const heroId = await createProject(pool, tenantId, { kind: "video", products: v.products, cast: v.cast, preset: v.preset, inspirationAdId: v.inspirationAdId, title: `${v.name} — hero`, campaignId: c.rows[0].id, role: "hero", sizes: ["9:16", "4:5"] }, by);
  await pool.query(`UPDATE creative_campaigns SET hero_project_id = $2::uuid WHERE id = $1::uuid`, [c.rows[0].id, heroId]);
  await enqueue(pool, tenantId, "campaign_pack", { campaignId: c.rows[0].id }, { requestedBy: by, afterSeconds: 60, progress: "Waiting for you to pick the hero concept" });
  return { campaignId: c.rows[0].id, heroId };
}

async function child(pool: Pool, hero: ProjectRow, campaignId: string, v: { kind: ProjectRow["kind"]; role: string; title: string; sizes: string[]; shots: Shot[]; status: string }) {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO creative_projects (tenant_id, campaign_id, role, title, kind, products, cast_ids, preset, inspiration_ad_id, sizes, created_by, status, concepts, concept_idx, shot_list, captions, brief)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12, $13::jsonb, $14, $15::jsonb, $16::jsonb, $17::jsonb) RETURNING id`,
    [
      hero.tenant_id, campaignId, v.role, v.title, v.kind, hero.products, hero.cast_ids, hero.preset, hero.inspiration_ad_id, v.sizes, null, v.status,
      JSON.stringify(hero.concepts), hero.concept_idx, JSON.stringify({ ...(hero.shot_list ?? { music: { mood: "deep house", bpm: 122 }, captions: [] }), shots: v.shots }), JSON.stringify(hero.captions), JSON.stringify(hero.brief),
    ],
  );
  const id = r.rows[0].id;
  // The hero's approved stills / clips are re-used, never re-generated.
  await pool.query(
    `INSERT INTO creative_generations (tenant_id, project_id, kind, shot_idx, size, provider, model, prompt, inputs, status, output_path, output_meta, critic, draft)
     SELECT tenant_id, $2::uuid, kind, shot_idx, size, provider, model, prompt, inputs, status, output_path, output_meta, critic, false
       FROM creative_generations WHERE project_id = $1::uuid AND kind IN ('still','clip') AND status = 'done' AND shot_idx = ANY($3::int[])`,
    [hero.id, id, v.shots.map((s) => s.idx)],
  );
  return id;
}

/** campaign_pack: once the hero has passing stills, spin out statics / carousel / stories / animated / UGC; once the hero is final, the cut-downs. */
export const campaignPack: JobHandler = async (pool, job, setProgress) => {
  const { campaignId, stage } = job.payload as { campaignId: string; stage?: "after_stills" | "after_final" };
  const c = (await pool.query(`SELECT * FROM creative_campaigns WHERE id = $1::uuid AND tenant_id = $2::uuid`, [campaignId, job.tenant_id])).rows[0];
  if (!c) throw new PlainError("Campaign gone.");
  const hero = await loadProject(pool, job.tenant_id, c.hero_project_id);
  const stills = await stillsByShot(pool, hero.id);
  const shots = (hero.shot_list?.shots ?? []).filter((s) => !s.is_end_card && stills.has(s.idx));
  if (!stage) {
    if (!["draft", "approved", "clips", "final"].includes(hero.status) || !shots.length)
      return { status: "waiting", afterSeconds: 60, progress: hero.status === "concepts" ? "Waiting for you to pick the hero concept" : "Waiting for the hero's stills" };
    await setProgress("Making the statics, carousel, stories and animated from the hero");
    const pick = (n: number, from = 0) => Array.from({ length: n }, (_, i) => shots[(from + i) % shots.length]);
    const made: string[] = [];
    for (let i = 0; i < PACK.statics; i++) made.push(await child(pool, hero, campaignId, { kind: "static", role: "static", title: `${c.name} — static ${i + 1}`, sizes: ["4:5"], shots: [pick(1, i)[0]], status: "stills" }));
    made.push(await child(pool, hero, campaignId, { kind: "static", role: "carousel", title: `${c.name} — carousel`, sizes: ["4:5"], shots: pick(Math.min(5, shots.length)), status: "stills" }));
    for (let i = 0; i < PACK.stories; i++) made.push(await child(pool, hero, campaignId, { kind: "static", role: "story", title: `${c.name} — story ${i + 1}`, sizes: ["9:16"], shots: [pick(1, i + 1)[0]], status: "stills" }));
    made.push(await child(pool, hero, campaignId, { kind: "animated", role: "animated", title: `${c.name} — animated`, sizes: ["9:16"], shots: [], status: "shots" }));
    for (const id of made) await enqueue(pool, job.tenant_id, "project_draft", {}, { projectId: id, requestedBy: job.requested_by });
    // UGC: same cast, the hero concept as its brief, its own script + clips.
    const ugc = await child(pool, hero, campaignId, { kind: "ugc", role: "ugc", title: `${c.name} — UGC`, sizes: ["9:16"], shots: [], status: "concepts" });
    await pool.query(`DELETE FROM creative_generations WHERE project_id = $1::uuid`, [ugc]);
    await enqueue(pool, job.tenant_id, "project_shots", { conceptIdx: hero.concept_idx ?? 0 }, { projectId: ugc, requestedBy: job.requested_by });
    await pool.query(`UPDATE creative_campaigns SET status = 'pack', updated_at = now() WHERE id = $1::uuid`, [campaignId]);
    return { status: "waiting", afterSeconds: 120, payload: { campaignId, stage: "after_stills" }, progress: "Pack made; waiting for the hero's final for the cut-downs" };
  }
  if (stage === "after_stills") {
    if (hero.status !== "final") return { status: "waiting", afterSeconds: 120, progress: "Waiting for the hero's final video (approve the hero draft)" };
    const clips = await clipsByShot(pool, hero.id);
    const withClips = shots.filter((s) => clips.has(s.idx));
    const lengths = [6, 8, 10];
    for (let i = 0; i < PACK.cutdowns; i++) {
      // Hook + 1–3 shots + end card, cut to 6–10 s.
      const target = lengths[i];
      const sel: Shot[] = [];
      let t = 1.6;
      for (const s of [withClips[0], ...withClips.slice(1 + i), ...withClips.slice(1, 1 + i)].filter(Boolean)) {
        if (t + s.duration_s > target) continue;
        sel.push(s);
        t += s.duration_s;
      }
      const id = await child(pool, hero, campaignId, { kind: "video", role: "cutdown", title: `${c.name} — cut-down ${target}s`, sizes: ["9:16"], shots: sel.length ? sel : withClips.slice(0, 2), status: "approved" });
      await enqueue(pool, job.tenant_id, "project_cutdown", {}, { projectId: id, requestedBy: job.requested_by });
    }
    await pool.query(`UPDATE creative_campaigns SET status = 'done', updated_at = now() WHERE id = $1::uuid`, [campaignId]);
    return { status: "done", progress: "Full campaign pack made" };
  }
  return { status: "done" };
};

/** A cut-down: the hero's clips re-edited (free render). */
export const projectCutdown: JobHandler = async (pool, job) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const st = job.payload as { renders?: string[] };
  if (st.renders) {
    const r = await renderState(pool, st.renders);
    if (r.failed) throw new PlainError(`Cut-down render failed: ${r.failed.slice(0, 200)}`);
    if (!r.done) return { status: "waiting", afterSeconds: 15, progress: "Rendering the cut-down (free)" };
    await setProject(pool, p.id, { status: "final" });
    return { status: "done", progress: "Cut-down ready" };
  }
  const { rerenderPlan } = await import("./chat");
  const plan = await rerenderPlan(pool, p, "9:16", true);
  return { status: "waiting", afterSeconds: 15, payload: { renders: [await queueRender(pool, p, plan, { draft: false, size: "9:16" })] }, progress: "Rendering the cut-down (free)" };
};
