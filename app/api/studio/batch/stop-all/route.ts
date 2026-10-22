import { withActivity } from "@/lib/server/activity-log";
/**
 * "Cancel pending batch" (owner, 2026-10-22): stop every run of the Studio
 * night batch that has not come back yet — see stopAllBatches in
 * lib/server/studio-batch.ts.
 *
 *   GET  /api/studio/batch/stop-all  → { pending: { runs, products, queued, sending, withOpenAi, openBatches } }
 *        (what the confirm line says it will stop)
 *   POST /api/studio/batch/stop-all  → { items: [{ id, productName, was, outcome, message }], batches: [{ openaiBatchId, cancelled, status, error }] }
 *
 * Queued runs are removed (nothing charged); every batch out with OpenAI is
 * cancelled there. Panels OpenAI had already finished are still billed; their
 * pictures are thrown away.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import OpenAI from "openai";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { pendingBatchSummary, stopAllBatches } from "@/lib/server/studio-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authed(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  return { session, pool };
}

export async function GET(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  try {
    return NextResponse.json({ pending: await pendingBatchSummary(a.pool, a.session.tid) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the batch" }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const apiKey = getOpenAiApiKey().trim();
  try {
    const out = await stopAllBatches(a.pool, apiKey ? new OpenAI({ apiKey }) : null, a.session.tid, a.session.email || null);
    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not cancel the batch" }, { status: 500 });
  }
}

export const POST = withActivity("studio/batch/stop-all", POST_handler);
