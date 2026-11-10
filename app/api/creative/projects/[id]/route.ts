/**
 * GET  /api/creative/projects/<id> — one creative: concepts, shot list, stills (critic-passed
 *      only, with scores), draft / final files, jobs, spend, chat, cast, product twins.
 * POST /api/creative/projects/<id> {action} — the owner's taps:
 *      concepts (modifier: crazier | luxury | new) · pick (concept 0–2) · approve · chat (plain words)
 *      · feedback (up / down) · post (to CarbonCast, needs approval there) · retry · delete.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withActivity } from "@/lib/server/activity-log";
import { guard, fail, body, kick } from "@/lib/server/creative/http";
import { approveProject, projectView } from "@/lib/server/creative/pipeline";
import { enqueue } from "@/lib/server/creative/jobs";
import { chatEdit } from "@/lib/server/creative/chat";
import { recordFeedback } from "@/lib/server/creative/learning";
import { createCarbonCastPost, nextBestTime } from "@/lib/server/creative/publish";
import { loadProject, setProject } from "@/lib/server/creative/produce";
import { appFileUrl } from "@/lib/server/creative/storage";
import { criticSummary } from "@/lib/server/creative/critic";
import { PlainError } from "@/lib/server/creative/config";
import { UGC_NOTICE } from "@/lib/server/creative/ugc";
import { listAudio } from "@/lib/server/creative/audio";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };
const UUID = /^[0-9a-f-]{36}$/;

export async function GET(req: Request, { params }: Ctx) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const v = await projectView(g.pool, g.session.tid, id);
    const concepts = ((v.project.concepts ?? []) as { storyboard?: { thumb?: string }[] }[]).map((c) => ({ ...c, storyboard: (c.storyboard ?? []).map((f) => ({ ...f, thumbUrl: appFileUrl(f.thumb ?? null) })) }));
    const music = await listAudio(g.pool, g.session.tid, "music");
    const trackId = (v.project.edit_plan as { trackId?: string } | null)?.trackId ?? null;
    return NextResponse.json({
      project: { ...v.project, concepts },
      // The owner only sees what passed the critic (spec §9): rejected / failed attempts stay hidden.
      stills: v.generations.filter((x) => x.kind === "still" && x.status === "done").map((x) => ({ id: x.id, shotIdx: x.shot_idx, url: appFileUrl(x.output_path), critic: x.critic, note: criticSummary(x.critic), attempt: x.attempt, cost: Number(x.cost_usd ?? 0) })),
      clips: v.generations.filter((x) => x.kind === "clip" && x.status === "done").map((x) => ({ id: x.id, shotIdx: x.shot_idx, url: appFileUrl(x.output_path), engine: x.model, critic: x.critic, note: criticSummary(x.critic), cost: Number(x.cost_usd ?? 0) })),
      renders: v.generations
        .filter((x) => x.kind === "render" && x.status === "done" && x.output_path)
        .reverse()
        .map((x) => ({ id: x.id, size: x.size, draft: x.draft, url: appFileUrl(x.output_path), poster: appFileUrl(x.output_meta?.poster ?? null), kind: /\.mp4$/.test(x.output_path) ? "video" : "image", shotIdx: x.shot_idx, createdAt: x.created_at })),
      rendersRunning: v.generations.filter((x) => x.kind === "render" && ["queued", "running"].includes(x.status)).length,
      attempts: { rejected: v.generations.filter((x) => x.status === "rejected").length, failed: v.generations.filter((x) => x.status === "failed").length },
      jobs: v.jobs,
      spend: v.spend,
      chat: v.chat,
      cast: v.cast,
      twins: v.twins.map((t) =>
        t
          ? {
              productId: t.product_id,
              title: t.title,
              status: t.status,
              confirmed: Boolean(t.confirmed_at),
              facts: t.facts,
              error: t.error,
              cutouts: (t.cutouts ?? []).map((c: { angle: string; storage_path: string }) => ({ angle: c.angle, url: appFileUrl(c.storage_path) })),
              details: (t.details ?? []).map((d: { kind: string; storage_path: string }) => ({ kind: d.kind, url: appFileUrl(d.storage_path) })),
            }
          : null,
      ),
      finalEstimate: v.finalEstimate,
      music: { trackId, track: music.find((m) => m.id === trackId)?.name ?? null, libraryCount: music.length },
      notice: v.project.kind === "ugc" ? UGC_NOTICE : null,
    });
  } catch (e) {
    return fail(e);
  }
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("concepts"), modifier: z.enum(["crazier", "luxury", "new"]).nullable().optional() }),
  z.object({ action: z.literal("pick"), concept: z.number().int().min(0).max(2) }),
  z.object({ action: z.literal("approve"), upscale4k: z.boolean().optional() }),
  z.object({ action: z.literal("chat"), text: z.string().min(1).max(1000) }),
  z.object({ action: z.literal("feedback"), verdict: z.enum(["up", "down"]), note: z.string().max(300).optional() }),
  z.object({ action: z.literal("post"), caption: z.string().max(2200), hashtags: z.array(z.string().max(60)).max(30), at: z.string().datetime({ offset: true }).nullable().optional(), useBestTime: z.boolean().optional(), size: z.string().max(5).optional() }),
  z.object({ action: z.literal("retry") }),
  z.object({ action: z.literal("delete") }),
]);

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const tid = g.session.tid;
  const by = g.session.email ?? null;
  try {
    const a = await body(req, schema);
    const p = await loadProject(g.pool, tid, id);
    switch (a.action) {
      case "concepts":
        await recordFeedback(g.pool, tid, { target: "concept", targetId: id, verdict: "skip", note: a.modifier ?? "new ideas", by });
        await enqueue(g.pool, tid, "project_concepts", { modifier: a.modifier ?? "new" }, { projectId: id, requestedBy: by, progress: "New concepts" });
        await setProject(g.pool, id, { status: "brief", step_note: null });
        break;
      case "pick":
        await enqueue(g.pool, tid, "project_shots", { conceptIdx: a.concept }, { projectId: id, requestedBy: by, progress: "Writing the shot list" });
        await setProject(g.pool, id, { status: "shots", step_note: null, concept_idx: a.concept });
        break;
      case "approve":
        await approveProject(g.pool, tid, id, by, { upscale4k: a.upscale4k });
        await recordFeedback(g.pool, tid, { target: "project", targetId: id, verdict: "up", note: "approved draft", by });
        break;
      case "chat": {
        const r = await chatEdit(g.pool, tid, id, a.text, by);
        kick(g.pool, tid);
        return NextResponse.json(r);
      }
      case "feedback":
        await recordFeedback(g.pool, tid, { target: "project", targetId: id, verdict: a.verdict, note: a.note, by });
        await g.pool.query(`UPDATE creative_projects SET feedback = $2 WHERE id = $1::uuid`, [id, a.verdict]);
        return NextResponse.json({ ok: true });
      case "post": {
        if (p.status !== "final") throw new PlainError("Approve it first — only finished creatives can be posted.");
        const outs = await g.pool.query<{ output_path: string; size: string | null; shot_idx: number | null; output_meta: { poster?: string } | null }>(
          `SELECT output_path, size, shot_idx, output_meta FROM creative_generations WHERE project_id = $1::uuid AND kind = 'render' AND status = 'done' AND output_path IS NOT NULL ORDER BY created_at DESC`,
          [id],
        );
        const size = a.size ?? (p.kind === "static" ? (p.role === "story" ? "9:16" : p.sizes[0] ?? "4:5") : "9:16");
        const ofSize = outs.rows.filter((o) => (o.size ?? size) === size);
        if (!ofSize.length) throw new PlainError(`No finished ${size} file to post.`);
        const isVideo = ofSize.some((o) => o.output_path.endsWith(".mp4"));
        // Latest render per slide for statics; the latest video for video.
        const files = isVideo
          ? [ofSize.find((o) => o.output_path.endsWith(".mp4"))!].map((o) => ({ path: o.output_path, kind: "video" as const, cover: o.output_meta?.poster ?? null }))
          : [...new Map([...ofSize].reverse().map((o) => [o.shot_idx, o])).values()].sort((x, y) => (x.shot_idx ?? 0) - (y.shot_idx ?? 0)).map((o) => ({ path: o.output_path, kind: "image" as const }));
        const at = a.at ?? (a.useBestTime !== false ? await nextBestTime(g.pool, tid) : null);
        const concept = ((p.concepts ?? []) as { recipe_key?: string; hook?: { text?: string | null }; music?: { mood?: string } }[])[p.concept_idx ?? 0];
        const postId = await createCarbonCastPost(g.pool, tid, {
          projectId: id,
          files,
          caption: a.caption,
          hashtags: a.hashtags,
          format: isVideo ? "reel" : p.role === "story" ? "story" : files.length > 1 ? "carousel" : "image",
          at,
          by,
          title: p.title || "Creative",
          meta: { recipe: concept?.recipe_key ?? null, models: p.cast_ids, preset: p.preset, music: concept?.music?.mood ?? null, hook: concept?.hook?.text ?? null },
        });
        return NextResponse.json({ postId, scheduledAt: at, note: "Added to Social → Calendar as a draft. Approve it there and it goes out at that time." });
      }
      case "retry": {
        const j = await g.pool.query<{ id: string }>(`SELECT id::text FROM creative_jobs WHERE project_id = $1::uuid AND status IN ('failed','paused') ORDER BY updated_at DESC LIMIT 1`, [id]);
        if (!j.rows[0]) throw new PlainError("Nothing to retry.");
        await g.pool.query(`UPDATE creative_jobs SET status = 'queued', error = NULL, attempts = 0, run_after = now(), progress = 'Trying again' WHERE id = $1::uuid`, [j.rows[0].id]);
        await setProject(g.pool, id, { step_note: null });
        break;
      }
      case "delete":
        await g.pool.query(`DELETE FROM creative_projects WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, tid]);
        return NextResponse.json({ ok: true });
    }
    kick(g.pool, tid);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (e) {
    return fail(e);
  }
}

export const POST = withActivity("creative/projects", POST_handler);
