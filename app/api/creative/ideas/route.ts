/**
 * POST  /api/creative/ideas — "Give me ideas": ONE cheap LLM call → 3–5 text-only cards (no
 *       pictures, no video, nothing in the background). "Make this" opens Create pre-filled.
 * PATCH /api/creative/ideas {id, status: skipped} — Skip.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withActivity } from "@/lib/server/activity-log";
import { guard, fail, body } from "@/lib/server/creative/http";
import { giveIdeas } from "@/lib/server/creative/ideas";
import { recordFeedback } from "@/lib/server/creative/learning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function POST_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    return NextResponse.json(await giveIdeas(g.pool, g.session.tid));
  } catch (e) {
    return fail(e);
  }
}

async function PATCH_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const b = await body(req, z.object({ id: z.string().uuid(), status: z.enum(["skipped"]) }));
    await g.pool.query(`UPDATE creative_ideas SET status = $3 WHERE id = $1::uuid AND tenant_id = $2::uuid`, [b.id, g.session.tid, b.status]);
    await recordFeedback(g.pool, g.session.tid, { target: "idea", targetId: b.id, verdict: "skip", by: g.session.email ?? null });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

export const POST = withActivity("creative/ideas", POST_handler);
export const PATCH = withActivity("creative/ideas", PATCH_handler);
