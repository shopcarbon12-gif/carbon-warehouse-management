import { withActivity } from "@/lib/server/activity-log";
/**
 * "■ Stop generating" for one product run in the Studio night batch
 * (owner, 2026-10-22). Works at every stage — see stopBatchItem in
 * lib/server/studio-batch.ts:
 *
 *   POST /api/studio/batch/<id>/stop
 *        → { item: { id, was, outcome, message, … } }
 *
 *   queued     → removed; nothing was sent, nothing is charged.
 *   preparing  → left out of the send that is running now.
 *   submitted  → OpenAI cancels the batch when no other product's run is in
 *                it; otherwise OpenAI finishes the batch for the others and
 *                this run's pictures are thrown away (its panels are billed).
 *
 * The OpenAI key lives only in the web app, which is why this is a web route.
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import OpenAI from "openai";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getOpenAiApiKey } from "@/lib/openaiConfig";
import { stopBatchItem } from "@/lib/server/studio-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

async function POST_handler(req: NextRequest, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  // No key: a queued run is still removed; a sent one is stopped here and its pictures thrown away.
  const apiKey = getOpenAiApiKey().trim();
  try {
    const item = await stopBatchItem(pool, apiKey ? new OpenAI({ apiKey }) : null, session.tid, id, session.email || null);
    if (item.outcome === "not_found") return NextResponse.json({ error: item.message, item }, { status: 404 });
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not stop this run" }, { status: 500 });
  }
}

export const POST = withActivity("studio/batch/[id]/stop", POST_handler);
