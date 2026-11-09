import { withActivity } from "@/lib/server/activity-log";
/**
 * Email brand kit (phase 2): the styles new blank emails start with + the brand colours.
 *   GET /api/email/editor/brand-kit → { kit: { styles, colors, updated_at, updated_by } | null }
 *   PUT /api/email/editor/brand-kit { styles, colors }
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { getKit, saveKit } from "@/lib/server/email/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  return NextResponse.json({ kit: await getKit(g.pool, g.session.tid) });
}

async function PUT_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  try {
    await saveKit(g.pool, g.session.tid, g.session.email ?? null, await req.json().catch(() => null));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const PUT = withActivity("email/editor/brand-kit", PUT_handler);
