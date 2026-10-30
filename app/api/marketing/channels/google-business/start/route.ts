/**
 * GET /api/marketing/channels/google-business/start — "Connect Google Business":
 * sends the admin to Google to sign in and allow managing the Business
 * Profile; Google comes back to /callback.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { googleBusinessAuthorizeUrl, googleBusinessConfigured } from "@/lib/server/marketing/google-business";
import { seal } from "@/lib/server/secret-box";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  if (!googleBusinessConfigured()) return NextResponse.json({ error: "The Google sign-in keys are not on the server yet" }, { status: 503 });
  const state = seal(JSON.stringify({ tid: g.session.tid, sub: g.session.sub, t: Date.now() }));
  return NextResponse.redirect(googleBusinessAuthorizeUrl(state));
}
