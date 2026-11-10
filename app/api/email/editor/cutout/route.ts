import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/editor/cutout { url } — the photo with its studio backdrop made transparent (PNG),
 * saved to the picture library (lib/server/email/cutout.ts). For hero designs that put a cut-out on the type.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { cutoutFromUrl } from "@/lib/server/email/cutout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const p = z.object({ url: z.string().url().max(2000) }).strict().safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: "Pick a photo first" }, { status: 400 });
  try {
    return NextResponse.json({ image: await cutoutFromUrl(g.pool, g.session.tid, g.session.email ?? null, p.data.url) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = withActivity("email/editor/cutout", POST_handler);
