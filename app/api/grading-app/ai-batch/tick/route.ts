import { NextResponse, after } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { gradingAiTick, openGradingAiJobs } from "@/lib/server/grading-app-batch";

/**
 * CarbonGradingAI's AI batch — one pass (lib/server/grading-app-batch.ts):
 * store OpenAI's answers, send the next rounds, put finished placements on
 * their scans.
 *
 *   POST /api/grading-app/ai-batch/tick → 202 { open }
 *
 * The worker calls it every minute while jobs are open (the OpenAI key lives
 * only in the web app). Machine traffic: not in Activity history — the scan
 * save that starts the jobs is.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  after(async () => {
    try {
      await gradingAiTick(pool);
    } catch (e) {
      console.error("[grading-ai] tick failed:", e instanceof Error ? e.message : e);
    }
  });
  return NextResponse.json({ open: await openGradingAiJobs(pool) }, { status: 202 });
}
