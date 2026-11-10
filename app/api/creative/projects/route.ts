/**
 * GET  /api/creative/projects — the Library: every CARBON creative and campaign, with its finished
 *      files, cost, posts and results.
 * POST /api/creative/projects — Create: {kind: static | video | ugc | animated | campaign, products,
 *      cast ("auto" or model ids), preset, inspirationAdId, ideaId, recipe}. Starts with the free /
 *      cheap steps only (product twin, 3 concepts).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withActivity } from "@/lib/server/activity-log";
import { guard, fail, body, kick } from "@/lib/server/creative/http";
import { createProject } from "@/lib/server/creative/pipeline";
import { createCampaign } from "@/lib/server/creative/campaign";
import { appFileUrl } from "@/lib/server/creative/storage";
import { ANIMATED_TEMPLATES, type AnimatedTemplate } from "@/lib/server/creative/animated";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const tid = g.session.tid;
    const r = await g.pool.query(
      `SELECT p.id::text, p.title, p.kind, p.role, p.status, p.step_note, p.campaign_id::text, p.preset, p.created_at, p.updated_at, p.feedback, p.ai_generated,
              c.name AS campaign_name,
              (SELECT COALESCE(SUM(cost_usd), 0) FROM creative_spend s WHERE s.project_id = p.id) AS spend,
              (SELECT json_agg(json_build_object('path', x.output_path, 'size', x.size, 'kind', CASE WHEN x.output_path LIKE '%.mp4' THEN 'video' ELSE 'image' END, 'poster', x.output_meta->>'poster', 'draft', x.draft) ORDER BY x.created_at DESC)
                 FROM creative_generations x WHERE x.project_id = p.id AND x.kind = 'render' AND x.status = 'done' AND x.output_path IS NOT NULL) AS outputs,
              (SELECT output_path FROM creative_generations x WHERE x.project_id = p.id AND x.kind = 'still' AND x.status = 'done' ORDER BY x.created_at LIMIT 1) AS first_still,
              (SELECT json_agg(json_build_object('postId', cp.post_id, 'results', cp.results, 'sales', cp.sales, 'status', mp.status, 'scheduledAt', mp.scheduled_at))
                 FROM creative_posts cp JOIN marketing_posts mp ON mp.id = cp.post_id WHERE cp.project_id = p.id) AS posts
         FROM creative_projects p LEFT JOIN creative_campaigns c ON c.id = p.campaign_id
        WHERE p.tenant_id = $1::uuid ORDER BY p.updated_at DESC LIMIT 200`,
      [tid],
    );
    return NextResponse.json({
      projects: r.rows.map((p) => {
        const outs = (p.outputs ?? []) as { path: string; size: string; kind: string; poster: string | null; draft: boolean }[];
        const latest = outs[0];
        return {
          ...p,
          spend: Number(p.spend),
          cover: appFileUrl(latest?.kind === "video" ? latest.poster : latest?.path ?? p.first_still),
          video: latest?.kind === "video" ? appFileUrl(latest.path) : null,
          outputs: outs.map((o) => ({ ...o, url: appFileUrl(o.path), poster: appFileUrl(o.poster) })),
        };
      }),
    });
  } catch (e) {
    return fail(e);
  }
}

const TEMPLATES = Object.keys(ANIMATED_TEMPLATES) as [AnimatedTemplate, ...AnimatedTemplate[]];
const schema = z.object({
  kind: z.enum(["static", "video", "ugc", "animated", "campaign"]),
  products: z.array(z.string().startsWith("gid://shopify/Product/")).min(1).max(6),
  cast: z.union([z.literal("auto"), z.array(z.string().max(60)).max(4)]).default("auto"),
  preset: z.string().max(30).nullable().optional(),
  inspirationAdId: z.string().uuid().nullable().optional(),
  ideaId: z.string().uuid().nullable().optional(),
  recipe: z.string().max(80).nullable().optional(),
  template: z.enum(TEMPLATES).nullable().optional(),
  title: z.string().max(120).optional(),
  sizes: z.array(z.enum(["4:5", "9:16", "1:1"])).max(3).optional(),
});

async function POST_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const b = await body(req, schema);
    const by = g.session.email ?? null;
    let out: { projectId: string; campaignId?: string };
    if (b.kind === "campaign") {
      const c = await createCampaign(g.pool, g.session.tid, { name: b.title ?? "New drop", products: b.products, preset: b.preset, cast: b.cast, inspirationAdId: b.inspirationAdId }, by);
      out = { projectId: c.heroId, campaignId: c.campaignId };
    } else {
      out = {
        projectId: await createProject(
          g.pool,
          g.session.tid,
          { kind: b.kind, products: b.products, cast: b.cast, preset: b.preset, inspirationAdId: b.inspirationAdId, ideaId: b.ideaId, recipe: b.recipe, template: b.template, title: b.title, sizes: b.sizes },
          by,
        ),
      };
    }
    kick(g.pool, g.session.tid);
    return NextResponse.json(out, { status: 201 });
  } catch (e) {
    return fail(e);
  }
}

export const POST = withActivity("creative/projects", POST_handler);
