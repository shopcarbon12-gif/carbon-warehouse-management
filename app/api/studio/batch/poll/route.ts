import { withActivity } from "@/lib/server/activity-log";
/**
 * Studio night batch — ask OpenAI how the sent batches are doing and store
 * every one that finished (lib/server/studio-batch.ts).
 *
 *   POST /api/studio/batch/poll   → 202 { started: "poll" }   (409 while busy)
 *
 * The worker calls it every few minutes while a batch is out, and "Check now"
 * in the Studio calls it by hand. Machine traffic: not in Activity history
 * (the send itself, /api/studio/batch/run, is).
 */
import { NextResponse, after } from "next/server";
import type { NextRequest } from "next/server";
import OpenAI from "openai";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { pollStudioBatches, tryBatchLock } from "@/lib/server/studio-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is not set on the server." }, { status: 503 });

  const unlock = await tryBatchLock(pool);
  if (!unlock) {
    return NextResponse.json({ error: "The batch is already being sent or checked — try again in a minute.", busy: true }, { status: 409 });
  }
  after(async () => {
    try {
      const r = await pollStudioBatches(pool, { openai: new OpenAI({ apiKey }), tenantId: session.tid });
      if (r.processed) console.log(`[studio-batch] stored ${r.processed} finished batch(es)`);
    } catch (e) {
      console.error("[studio-batch] check failed:", e);
    } finally {
      await unlock();
    }
  });
  return NextResponse.json({ started: "poll" }, { status: 202 });
}

export const POST = withActivity("studio/batch/poll", POST_handler);
