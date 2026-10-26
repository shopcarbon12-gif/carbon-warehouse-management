import { withActivity } from "@/lib/server/activity-log";
/**
 * GET /api/marketing/channels/tiktok/callback?code&state — TikTok sends the
 * admin back here after they allow posting: the code becomes tokens (kept
 * sealed), the account is saved as connected, and the page returns to
 * Social channels.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { tiktokExchangeCode, tiktokUserInfo } from "@/lib/server/marketing/tiktok";
import { PUBLIC_BASE } from "@/lib/server/marketing/store";
import { open, seal } from "@/lib/server/secret-box";

export const dynamic = "force-dynamic";

const back = (q: string) => NextResponse.redirect(`${PUBLIC_BASE}/integrations/social?${q}`);

async function GET_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const url = new URL(req.url);
  const err = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (err) return back(`tiktok=${encodeURIComponent(err)}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  try {
    const s = JSON.parse(open(state ?? "")) as { tid: string; t: number };
    if (s.tid !== g.session.tid || Date.now() - s.t > 15 * 60_000) throw new Error("This TikTok sign-in link expired — press Connect TikTok again");
    if (!code) throw new Error("TikTok did not send a code");
    const tokens = await tiktokExchangeCode(code);
    if (!tokens.scope.includes("video.publish")) throw new Error("Allow posting (video.publish) on TikTok's screen");
    const user = await tiktokUserInfo(tokens.access);
    await g.pool.query(`DELETE FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'tiktok'`, [g.session.tid]);
    await g.pool.query(
      `INSERT INTO marketing_channels (tenant_id, provider, account_id, name, status, secret, last_ok_at) VALUES ($1::uuid, 'tiktok', $2, $3, 'connected', $4, now())`,
      [g.session.tid, user.openId || tokens.openId, user.name, seal(JSON.stringify(tokens))],
    );
    return back("tiktok=connected");
  } catch (e) {
    return back(`tiktok=${encodeURIComponent(e instanceof Error ? e.message : "TikTok sign-in failed")}`);
  }
}

export const GET = withActivity("marketing/channels/tiktok/callback", GET_handler);
