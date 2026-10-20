import { withActivity } from "@/lib/server/activity-log";
/**
 * One product run in the Studio night batch.
 *
 *   GET    /api/studio/batch/<id>        → { runTag, gender, panels: [{ panel, poseA, poseB, imageBase64? | error? }] }
 *   PATCH  /api/studio/batch/<id>  { status: "loaded" }   — the results were brought into the Studio
 *   PATCH  /api/studio/batch/<id>  { status: "published" } — Bulk Studio › Upload pushed them to Shopify
 *   DELETE /api/studio/batch/<id>        — take a run out of the queue before it is sent
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { cancelBatchItem, loadBatchItemImages, markBatchItemLoaded, markBatchItemPublished } from "@/lib/server/studio-batch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { params: Promise<{ id: string }> };

async function authed(req: NextRequest, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return { error: NextResponse.json({ error: "Invalid id" }, { status: 400 }) };
  return { session, pool, id };
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const a = await authed(req, ctx);
  if ("error" in a) return a.error;
  const out = await loadBatchItemImages(a.pool, a.session.tid, a.id);
  if (!out) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
}

async function PATCH_handler(req: NextRequest, ctx: Ctx) {
  const a = await authed(req, ctx);
  if ("error" in a) return a.error;
  const body = (await req.json().catch(() => ({}))) as { status?: string };
  if (body.status === "published") return NextResponse.json({ ok: await markBatchItemPublished(a.pool, a.session.tid, a.id) });
  if (body.status !== "loaded") return NextResponse.json({ error: 'Only { status: "loaded" | "published" } is supported' }, { status: 400 });
  const ok = await markBatchItemLoaded(a.pool, a.session.tid, a.id);
  return NextResponse.json({ ok });
}

async function DELETE_handler(req: NextRequest, ctx: Ctx) {
  const a = await authed(req, ctx);
  if ("error" in a) return a.error;
  const ok = await cancelBatchItem(a.pool, a.session.tid, a.id);
  if (!ok) {
    return NextResponse.json({ error: "Only a run that has not been sent yet can be removed." }, { status: 409 });
  }
  return NextResponse.json({ ok });
}

export const PATCH = withActivity("studio/batch/[id]", PATCH_handler);
export const DELETE = withActivity("studio/batch/[id]", DELETE_handler);
