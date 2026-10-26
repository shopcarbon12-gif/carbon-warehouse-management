/**
 * GET /api/marketing/channels/tiktok/start — "Connect TikTok": sends the admin
 * to TikTok to sign in and allow posting; TikTok comes back to /callback.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { tiktokAuthorizeUrl, tiktokConfigured } from "@/lib/server/marketing/tiktok";
import { seal } from "@/lib/server/secret-box";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  if (!tiktokConfigured()) return NextResponse.json({ error: "The TikTok app keys are not on the server yet" }, { status: 503 });
  const state = seal(JSON.stringify({ tid: g.session.tid, sub: g.session.sub, t: Date.now() }));
  return NextResponse.redirect(tiktokAuthorizeUrl(state));
}
