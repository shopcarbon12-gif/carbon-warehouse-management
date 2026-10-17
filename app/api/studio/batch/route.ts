import { withActivity } from "@/lib/server/activity-log";
/**
 * Studio night batch — the queue (see lib/server/studio-batch.ts).
 *
 *   GET  /api/studio/batch?matrixId=<uuid>   → { items, overview }
 *        (no matrixId → the latest runs of every product)
 *   POST /api/studio/batch   { matrixId, runTag, modelName, modelGender,
 *                              itemColour, itemType, panels: [{ panel, body }] }
 *        → { item }   body = exactly what Generate would POST to /api/generate
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { batchOverview, enqueueBatchItem, listBatchItems, validateEnqueue } from "@/lib/server/studio-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const matrixId = String(new URL(req.url).searchParams.get("matrixId") || "").trim();
  if (matrixId && !UUID_RE.test(matrixId)) return NextResponse.json({ error: "Invalid matrixId" }, { status: 400 });
  try {
    const [items, overview] = await Promise.all([
      listBatchItems(a.pool, a.session.tid, matrixId ? { matrixId, limit: 20 } : { limit: 100 }),
      batchOverview(a.pool, a.session.tid),
    ]);
    return NextResponse.json({ items, overview });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the batch" }, { status: 500 });
  }
}

async function POST_handler(req: NextRequest) {
  const a = await authed(req);
  if ("error" in a) return a.error;
  const raw = await req.json().catch(() => null);
  const v = validateEnqueue(raw);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  try {
    const item = await enqueueBatchItem(a.pool, a.session, v.value);
    return NextResponse.json({ item: { id: item.id, addedAt: item.added_at, panels: v.value.panels.map((p) => p.panel) } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not add to the batch" }, { status: 500 });
  }
}

export const POST = withActivity("studio/batch", POST_handler);
