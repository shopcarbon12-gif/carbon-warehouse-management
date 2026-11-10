/**
 * GET /api/creative/jobs?project=<id> — job status (queued / running / waiting / done / failed /
 * paused, with a plain-English progress line and error) plus this month's spend.
 */
import { NextResponse } from "next/server";
import { guard, fail } from "@/lib/server/creative/http";
import { listJobs } from "@/lib/server/creative/jobs";
import { spendSummary } from "@/lib/server/creative/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const project = new URL(req.url).searchParams.get("project");
    return NextResponse.json({
      jobs: await listJobs(g.pool, g.session.tid, { projectId: project && /^[0-9a-f-]{36}$/.test(project) ? project : undefined, limit: 40 }),
      spend: await spendSummary(g.pool, g.session.tid),
    });
  } catch (e) {
    return fail(e);
  }
}
