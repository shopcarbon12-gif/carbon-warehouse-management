/**
 * GET /api/creative — Creative Home: spend this month (per provider, with caps), keys, the Brand
 * Brain wizard state, "what's working for CARBON" (real results only), recent projects and
 * campaigns, the latest idea cards, Radar counts and running jobs. Admin only.
 */
import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/server/creative/http";
import { getBrand, keysStatus, spendSummary } from "@/lib/server/creative/config";
import { whatsWorking } from "@/lib/server/creative/learning";
import { radarStats } from "@/lib/server/creative/radar/query";
import { listJobs } from "@/lib/server/creative/jobs";
import { appFileUrl } from "@/lib/server/creative/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const tid = g.session.tid;
    const [spend, brand, working, radar, jobs, projects, ideas, campaigns] = await Promise.all([
      spendSummary(g.pool, tid),
      getBrand(g.pool, tid),
      whatsWorking(g.pool, tid),
      radarStats(g.pool, tid),
      listJobs(g.pool, tid, { limit: 15 }),
      g.pool.query(
        `SELECT p.id::text, p.title, p.kind, p.status, p.step_note, p.role, p.campaign_id::text, p.updated_at, p.products,
                (SELECT output_path FROM creative_generations x WHERE x.project_id = p.id AND x.status = 'done' AND x.kind IN ('render','still') ORDER BY (x.kind = 'render') DESC, x.created_at DESC LIMIT 1) AS cover,
                (SELECT output_meta->>'poster' FROM creative_generations x WHERE x.project_id = p.id AND x.status = 'done' AND x.kind = 'render' ORDER BY x.created_at DESC LIMIT 1) AS poster,
                (SELECT COALESCE(SUM(cost_usd), 0) FROM creative_spend s WHERE s.project_id = p.id) AS spend
           FROM creative_projects p WHERE p.tenant_id = $1::uuid ORDER BY p.updated_at DESC LIMIT 24`,
        [tid],
      ),
      g.pool.query(`SELECT id::text, idea, reason, prefill, status, created_at FROM creative_ideas WHERE tenant_id = $1::uuid AND status = 'new' ORDER BY created_at DESC LIMIT 5`, [tid]),
      g.pool.query(`SELECT id::text, name, status, hero_project_id::text, created_at FROM creative_campaigns WHERE tenant_id = $1::uuid ORDER BY created_at DESC LIMIT 6`, [tid]),
    ]);
    return NextResponse.json({
      spend,
      keys: keysStatus(),
      brand: { wizardDone: brand.wizardDone, defaultPreset: brand.defaultPreset },
      working,
      radar: { kept: radar.kept, review: radar.review, rejected: radar.rejected, discovered: radar.discovered, season: radar.season },
      jobs,
      projects: projects.rows.map((p) => ({ ...p, cover: appFileUrl(p.poster || (/\.(jpg|png)$/i.test(p.cover ?? "") ? p.cover : null)), video: /\.mp4$/i.test(p.cover ?? "") ? appFileUrl(p.cover) : null, spend: Number(p.spend) })),
      ideas: ideas.rows,
      campaigns: campaigns.rows,
    });
  } catch (e) {
    return fail(e);
  }
}
