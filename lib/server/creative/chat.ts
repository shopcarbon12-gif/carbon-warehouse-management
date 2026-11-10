/**
 * CarbonWMS Creative — "Talk, don't edit" (spec §1.3 / §7). Every result has a chat box: "faster
 * cuts", "swap her for a guy", "make it more luxury", "bigger price text", "end on the back of the
 * jacket", "swap the music". One LLM call maps the words to internal changes; only what changed is
 * re-made: edit-only changes re-render for free; a changed shot re-makes that shot's still (and its
 * clip at the next approve).
 */
import type { Pool } from "pg";
import { z } from "zod";
import { PlainError } from "./config";
import { enqueue, type JobHandler } from "./jobs";
import { json } from "./llm";
import { autoCast, listModels } from "./casting";
import { buildPlan } from "./pipeline";
import { loadProject, queueRender, renderState, setProject, type ProjectRow } from "./produce";
import type { EditPlan } from "./editor";

const Change = z.object({
  reply: z.string().max(200),
  actions: z
    .array(
      z.discriminatedUnion("type", [
        z.object({ type: z.literal("speed"), factor: z.number().min(0.4).max(2) }),
        z.object({ type: z.literal("text_scale"), factor: z.number().min(0.6).max(2) }),
        z.object({ type: z.literal("music_swap") }),
        z.object({ type: z.literal("no_music"), value: z.boolean() }),
        z.object({ type: z.literal("preset"), key: z.enum(["street", "luxury", "evening", "florida"]) }),
        z.object({ type: z.literal("recast"), shots: z.array(z.number().int()).max(14), gender: z.enum(["female", "male", "any"]), model_id: z.string().nullable() }),
        z.object({
          type: z.literal("edit_shot"),
          idx: z.number().int(),
          subject_action: z.string().max(300).nullable(),
          garment_must_show: z.string().max(200).nullable(),
          still_prompt: z.string().max(1200).nullable(),
          motion_prompt: z.string().max(900).nullable(),
          text_overlay: z.string().max(80).nullable(),
          duration_s: z.number().min(0.5).max(10).nullable(),
          remake_picture: z.boolean(),
        }),
        z.object({ type: z.literal("caption"), text: z.string().max(2200) }),
        z.object({ type: z.literal("none") }),
      ]),
    )
    .max(8),
});
export type ChatChange = z.infer<typeof Change>;

export async function chatEdit(pool: Pool, tenantId: string, projectId: string, text: string, by: string | null): Promise<{ reply: string; change: ChatChange; rerender: "free" | "stills" | "none" }> {
  const p = await loadProject(pool, tenantId, projectId);
  if (!p.shot_list && p.kind !== "animated") throw new PlainError("Pick a concept first — then you can ask for changes.");
  await pool.query(`INSERT INTO creative_chat (tenant_id, project_id, role, text) VALUES ($1::uuid, $2::uuid, 'owner', $3)`, [tenantId, projectId, text.slice(0, 1000)]);
  const models = await listModels(pool, tenantId);
  const shots = (p.shot_list?.shots ?? []).map((s) => ({ idx: s.idx, subject_action: s.subject_action, garment_must_show: s.garment_must_show, text_overlay: s.text_overlay, duration_s: s.duration_s, cast: s.cast.map((c) => models.find((m) => m.id === c)?.name ?? c), is_end_card: s.is_end_card }));
  const prompt = [
    "The owner of CARBON is giving a change request on an ad in plain words. Map it to the smallest set of internal actions.",
    `AD: ${p.kind}, preset ${p.preset}. SHOTS: ${JSON.stringify(shots)}.`,
    `MODELS AVAILABLE: ${models.map((m) => `${m.name} [${m.id}] ${m.gender}`).join("; ")}`,
    `OWNER SAYS: "${text}"`,
    "Actions: speed (factor < 1 = faster cuts / shorter shots), text_scale (bigger / smaller words), music_swap, no_music, preset (more luxury → luxury, night → evening, street → street, Florida day → florida),",
    "recast (swap people: shots = shot idxs or [] for all; gender; model_id if they named someone), edit_shot (change one shot — e.g. 'end on the back of the jacket' = edit the LAST non-end-card shot: subject_action and garment_must_show about the back; remake_picture true when the picture must change),",
    "caption (new caption text), none (if it is only a question). reply = one short line saying what you'll do.",
  ].join("\n");
  const change = (await json(pool, prompt, Change, { tenantId, what: "chat edit (mapping)", projectId, maxOutputTokens: 1500 })).value;
  const ep: Record<string, unknown> & { overrides?: { speed?: number; textScale?: number }; rejectedTracks?: string[] } = { ...((p.edit_plan as Record<string, unknown>) ?? {}) };
  const ov = { ...(ep.overrides ?? {}) };
  const sl = p.shot_list ? { ...p.shot_list, shots: p.shot_list.shots.map((s) => ({ ...s })) } : null;
  const remake = new Set<number>();
  let preset = p.preset;
  let castIds = [...p.cast_ids];
  for (const a of change.actions) {
    if (a.type === "speed") ov.speed = Math.round((ov.speed ?? 1) * a.factor * 100) / 100;
    if (a.type === "text_scale") ov.textScale = Math.round((ov.textScale ?? 1) * a.factor * 100) / 100;
    if (a.type === "music_swap") {
      if (ep.trackId) ep.rejectedTracks = [...(ep.rejectedTracks ?? []), String(ep.trackId)];
      ep.trackId = null;
      ep.noMusic = false;
    }
    if (a.type === "no_music") ep.noMusic = a.value;
    if (a.type === "preset") preset = a.key;
    if (a.type === "caption") await setProject(pool, p.id, { captions: { ...((p.captions as Record<string, unknown>) ?? {}), options: [a.text, ...(((p.captions as { options?: string[] })?.options) ?? [])].slice(0, 4) } });
    if (a.type === "recast" && sl) {
      const target = a.model_id && models.some((m) => m.id === a.model_id) ? [models.find((m) => m.id === a.model_id)!] : await autoCast(pool, tenantId, { lane: null, gender: a.gender === "female" ? "women" : a.gender === "male" ? "men" : "unisex", count: 1, kind: p.kind, exclude: p.cast_ids });
      const newId = target[0].id;
      const idxs = a.shots.length ? a.shots : sl.shots.filter((s) => !s.is_end_card).map((s) => s.idx);
      for (const s of sl.shots) if (idxs.includes(s.idx) && !s.is_end_card) {
        s.cast = [newId];
        remake.add(s.idx);
      }
      castIds = [...new Set([...castIds.filter((c) => sl.shots.some((s) => s.cast.includes(c))), newId])];
    }
    if (a.type === "edit_shot" && sl) {
      const s = sl.shots.find((x) => x.idx === a.idx);
      if (!s) continue;
      if (a.subject_action) s.subject_action = a.subject_action;
      if (a.garment_must_show) s.garment_must_show = a.garment_must_show;
      if (a.still_prompt) s.still_prompt = a.still_prompt;
      else if (a.subject_action && a.remake_picture) s.still_prompt = `${a.subject_action}. ${a.garment_must_show ?? s.garment_must_show}. Same person, same outfit, same location and light as the rest of the ad.`;
      if (a.motion_prompt) s.motion_prompt = a.motion_prompt;
      if (a.text_overlay !== null) s.text_overlay = a.text_overlay;
      if (a.duration_s) s.duration_s = a.duration_s;
      if (a.remake_picture) remake.add(s.idx);
    }
  }
  ep.overrides = ov;
  await setProject(pool, p.id, { edit_plan: ep, shot_list: sl, preset, cast_ids: castIds });
  if (remake.size) {
    // The changed shots' old stills and clips are set aside; the rest are kept as they are.
    await pool.query(`UPDATE creative_generations SET status = 'cancelled' WHERE project_id = $1::uuid AND kind IN ('still','clip') AND shot_idx = ANY($2::int[]) AND status = 'done'`, [p.id, [...remake]]);
  }
  const rerender: "free" | "stills" | "none" = remake.size ? "stills" : change.actions.some((a) => a.type !== "none" && a.type !== "caption") ? "free" : "none";
  if (rerender === "stills") {
    await setProject(pool, p.id, { status: "shots" });
    await enqueue(pool, tenantId, "project_stills", { shots: [...remake] }, { projectId: p.id, requestedBy: by, progress: `Re-making shot${remake.size > 1 ? "s" : ""} ${[...remake].map((i) => i + 1).join(", ")}` });
  } else if (rerender === "free") {
    await enqueue(pool, tenantId, "project_rerender", {}, { projectId: p.id, requestedBy: by, progress: "Re-cutting (free)" });
  }
  await pool.query(`INSERT INTO creative_chat (tenant_id, project_id, role, text, change) VALUES ($1::uuid, $2::uuid, 'app', $3, $4::jsonb)`, [tenantId, projectId, change.reply, JSON.stringify({ ...change, rerender })]);
  await pool.query(`INSERT INTO creative_feedback (tenant_id, target, target_id, verdict, note, created_by) VALUES ($1::uuid, 'project', $2, 'edit', $3, $4)`, [tenantId, projectId, text.slice(0, 500), by]);
  return { reply: change.reply, change, rerender };
}

/** The edit plan again with the current shot list, overrides and media (clips when the project has them). */
export async function rerenderPlan(pool: Pool, p: ProjectRow, size: string, clips: boolean): Promise<EditPlan> {
  const ep = (p.edit_plan ?? {}) as { trackId?: string | null; noMusic?: boolean };
  return (await buildPlan(pool, p, size, { clips, draft: !clips, trackId: ep.trackId ?? null, noMusic: ep.noMusic ?? false })).plan;
}

/** project_rerender: edit-only changes → re-render (free). Final projects keep their clips. */
export const projectRerender: JobHandler = async (pool, job) => {
  const p = await loadProject(pool, job.tenant_id, job.project_id!);
  const st = job.payload as { renders?: string[] };
  if (st.renders) {
    const r = await renderState(pool, st.renders);
    if (r.failed) throw new PlainError(`Re-render failed: ${r.failed.slice(0, 200)}`);
    if (!r.done) return { status: "waiting", afterSeconds: 15, progress: "Re-cutting (free)" };
    return { status: "done", progress: "Updated" };
  }
  if (p.kind === "static" || p.kind === "animated") {
    await enqueue(pool, job.tenant_id, "project_draft", {}, { projectId: p.id, requestedBy: job.requested_by });
    await setProject(pool, p.id, { status: "stills" });
    return { status: "done", progress: "Re-laying out" };
  }
  const hasClips = ["final", "clips"].includes(p.status);
  const renders: string[] = [];
  for (const size of p.sizes.length ? p.sizes : ["9:16"]) {
    const plan = await rerenderPlan(pool, p, size, hasClips);
    renders.push(await queueRender(pool, p, plan, { draft: !hasClips, size }));
  }
  return { status: "waiting", afterSeconds: 15, payload: { renders }, progress: "Re-cutting (free)" };
};
