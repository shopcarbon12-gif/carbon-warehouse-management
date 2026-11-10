/**
 * POST /api/creative/tick — run due Creative jobs (the web app holds the OpenAI + fal.ai keys).
 * The worker calls it once a minute while anything is due, and at 03:00 ET queues Radar's nightly
 * collection (body {nightly: true}). Answers at once, works in the background. Machine traffic:
 * not in Activity history.
 */
import { NextResponse } from "next/server";
import { guard, kick } from "@/lib/server/creative/http";
import { enqueue } from "@/lib/server/creative/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

export async function POST(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const b = (await req.json().catch(() => ({}))) as { nightly?: boolean; learning?: boolean };
  if (b.nightly) {
    const open = await g.pool.query(`SELECT 1 FROM creative_jobs WHERE tenant_id = $1::uuid AND kind = 'radar_nightly' AND created_at > now() - interval '20 hours' LIMIT 1`, [g.session.tid]);
    if (!open.rows[0]) await enqueue(g.pool, g.session.tid, "radar_nightly", {}, { requestedBy: g.session.email ?? null, progress: "Nightly Radar collection" });
  }
  if (b.learning) await enqueue(g.pool, g.session.tid, "learning_refresh", {}, { requestedBy: g.session.email ?? null });
  kick(g.pool, g.session.tid);
  return NextResponse.json({ started: true }, { status: 202 });
}
