import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { copyGrading, undoCopy, UUID_RE } from "@/lib/server/grading-app";

export const dynamic = "force-dynamic";

/**
 * CarbonGradingAI › Compare (owner, 2026-10-22).
 * POST {fromMatrixId, toMatrixId, overrides: {SIZE: {key: cm}}} — copy the other
 *   product's grading onto every size of this one (the compared size as edited).
 * DELETE {rowIds} — undo that copy (only rows a copy wrote are removed).
 */
const Copy = z.object({
  fromMatrixId: z.string().regex(UUID_RE),
  toMatrixId: z.string().regex(UUID_RE),
  overrides: z.record(z.string().max(20), z.record(z.string().max(40), z.number().finite())).default({}),
});
const Undo = z.object({ rowIds: z.array(z.string().regex(UUID_RE)).max(5000) });

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const parsed = Copy.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "fromMatrixId, toMatrixId and overrides are required." }, { status: 400 });
  if (parsed.data.fromMatrixId === parsed.data.toMatrixId) return NextResponse.json({ error: "Pick a different product to copy from." }, { status: 400 });
  const overrides = Object.fromEntries(Object.entries(parsed.data.overrides).map(([k, v]) => [k.trim().toUpperCase(), v]));
  try {
    return NextResponse.json({ ok: true, ...(await copyGrading(pool, session.sub ?? null, { ...parsed.data, overrides })) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not copy" }, { status: 500 });
  }
}

async function DELETE_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const parsed = Undo.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "rowIds required." }, { status: 400 });
  return NextResponse.json({ ok: true, removed: await undoCopy(pool, parsed.data.rowIds) });
}

export const POST = withActivity("grading-app/copy", POST_handler);
export const DELETE = withActivity("grading-app/copy", DELETE_handler);
