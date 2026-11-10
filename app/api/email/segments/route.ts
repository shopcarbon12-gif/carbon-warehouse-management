import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/email/segments            — saved segments with how many people are in each now.
 * POST /api/email/segments            — { name, rules } save one; { count: rules } only counts (and samples) without saving.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { listSegments, saveSegment, segmentCount, segmentSample } from "@/lib/server/email/segments";
import { isRules } from "@/lib/email-editor/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  return NextResponse.json({ segments: await listSegments(g.pool, g.session.tid) });
}

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const body = (await req.json().catch(() => null)) as { name?: unknown; rules?: unknown; count?: unknown } | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    if (body.count !== undefined) {
      if (!isRules(body.count)) return NextResponse.json({ error: "Invalid rules" }, { status: 400 });
      const [count, sample] = await Promise.all([segmentCount(g.pool, g.session.tid, body.count), segmentSample(g.pool, g.session.tid, body.count)]);
      return NextResponse.json({ count, sample });
    }
    return NextResponse.json({ id: await saveSegment(g.pool, g.session.tid, g.session.email ?? null, { name: body.name, rules: body.rules }) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = withActivity("email/segments", POST_handler);
