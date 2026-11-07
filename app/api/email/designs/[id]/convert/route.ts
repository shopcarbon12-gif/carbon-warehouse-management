import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/designs/<id>/convert { messageId } — "Convert to email":
 * the chosen version's desktop + mobile pictures become a real responsive
 * email (lib/server/email/convert.ts). Runs in the background (a few minutes).
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { startConvert } from "@/lib/server/email/convert";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const b = (await req.json().catch(() => ({}))) as { messageId?: unknown };
  const mid = typeof b.messageId === "string" ? b.messageId : "";
  if (!UUID_RE.test(id) || !UUID_RE.test(mid)) return NextResponse.json({ error: "Pick a version" }, { status: 400 });
  try {
    await startConvert(g.pool, g.session.tid, id, mid);
    return NextResponse.json({ started: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}

export const POST = withActivity("email/designs/[id]/convert", POST_handler);
