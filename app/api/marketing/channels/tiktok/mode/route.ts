import { withActivity } from "@/lib/server/activity-log";
/**
 * GET /api/marketing/channels/tiktok/mode — how calendar posts go to TikTok: "drafts" (the TikTok app's
 * inbox; the person posts it from the app) or "direct" (CarbonWMS posts it — public only once TikTok has
 * reviewed the app). POST { mode } changes it. Owner, 2026-11-14.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { setTikTokPostMode, tiktokPostMode } from "@/lib/server/marketing/tiktok";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  return NextResponse.json({ mode: await tiktokPostMode(g.pool, g.session.tid) });
}

const schema = z.object({ mode: z.enum(["drafts", "direct"]) }).strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Choose drafts or direct" }, { status: 400 });
  if (!(await setTikTokPostMode(g.pool, g.session.tid, parsed.data.mode))) return NextResponse.json({ error: "TikTok is not connected" }, { status: 409 });
  return NextResponse.json({ mode: parsed.data.mode });
}

export const POST = withActivity("marketing/channels/tiktok/mode", POST_handler);
