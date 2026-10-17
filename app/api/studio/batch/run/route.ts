import { withActivity } from "@/lib/server/activity-log";
/**
 * Studio night batch — send everything queued to OpenAI now.
 *
 *   POST /api/studio/batch/run  { trigger?: "nightly" | "manual" }
 *        → 202 { started }   (409 while another send/check is still running)
 *
 * The worker calls this at 1 AM Eastern (trigger "nightly"); "Send now" in the
 * Studio calls it by hand. Checking on a sent batch is /api/studio/batch/poll.
 * The OpenAI key lives only in the web app, which is why the work happens here
 * and not in the worker. It runs after the response, under one Postgres
 * advisory lock, so two sends can never overlap.
 *
 * Each panel's request is built by /api/generate itself in prepare-only mode,
 * signed as the person who queued it — the batch renders exactly what their
 * Generate press would have, with exactly their access.
 */
import { NextRequest, NextResponse, after } from "next/server";
import OpenAI from "openai";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { signSession } from "@/lib/auth";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { POST as generatePOST } from "@/app/api/generate/route";
import {
  pollStudioBatches,
  recoverInterruptedSends,
  submitQueuedBatch,
  tryBatchLock,
  type PrepareFn,
  type PreparedPanel,
} from "@/lib/server/studio-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function POST_handler(req: NextRequest) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { trigger?: string };
  const trigger = body.trigger === "nightly" ? "nightly" : "manual";
  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) return NextResponse.json({ error: "OPENAI_API_KEY is not set on the server." }, { status: 503 });

  const unlock = await tryBatchLock(pool);
  if (!unlock) {
    return NextResponse.json({ error: "The batch is already being sent or checked — try again in a minute.", busy: true }, { status: 409 });
  }

  const generateUrl = new URL("/api/generate", req.url);
  const prepare: PrepareFn = async (panelBody, actor) => {
    const token = await signSession({
      sub: actor.addedBy ?? session.sub,
      email: actor.addedEmail ?? session.email,
      tid: session.tid,
      lid: actor.locationId ?? session.lid,
      role: actor.addedRole ?? session.role,
    });
    const res = await generatePOST(
      new NextRequest(generateUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-generate-prepare": "1",
        },
        body: JSON.stringify(panelBody),
      }),
    );
    const j = (await res.json().catch(() => null)) as
      | { prepared?: PreparedPanel; meta?: Record<string, unknown>; error?: { message?: string } | string }
      | null;
    if (j?.prepared) return { prepared: j.prepared, meta: j.meta ?? {} };
    const e = j?.error;
    return { error: (typeof e === "string" ? e : e?.message) || `the request builder answered HTTP ${res.status}` };
  };

  after(async () => {
    const openai = new OpenAI({ apiKey });
    try {
      const recovered = await recoverInterruptedSends(pool, openai, session.tid);
      if (recovered) console.log(`[studio-batch] put ${recovered} interrupted send(s) back in the queue`);
      await submitQueuedBatch(pool, { tenantId: session.tid, trigger, prepare, openai });
      await pollStudioBatches(pool, { openai, tenantId: session.tid });
    } catch (e) {
      console.error("[studio-batch] send failed:", e);
    } finally {
      await unlock();
    }
  });

  return NextResponse.json({ started: "submit", trigger }, { status: 202 });
}

export const POST = withActivity("studio/batch/run", POST_handler);
