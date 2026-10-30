import { withActivity } from "@/lib/server/activity-log";
/**
 * GET /api/marketing/channels/google-business/callback?code&state — Google
 * sends the admin back here: the code becomes a lasting sign-in (kept sealed),
 * the open store location is saved as the connected Google Business channel,
 * and the page returns to Social channels.
 */
import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { googleBusinessExchangeCode, googleBusinessLocations } from "@/lib/server/marketing/google-business";
import { PUBLIC_BASE } from "@/lib/server/marketing/store";
import { open, seal } from "@/lib/server/secret-box";

export const dynamic = "force-dynamic";

const back = (q: string) => NextResponse.redirect(`${PUBLIC_BASE}/integrations/social?${q}`);

async function GET_handler(req: Request) {
  // No session needed: the phone's TikTok/Google app often returns in its own browser.
  // The sealed state (minted by /start for a signed-in admin, 15 minutes) proves who asked.
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const url = new URL(req.url);
  const err = url.searchParams.get("error_description") || url.searchParams.get("error");
  if (err) return back(`google=${encodeURIComponent(err)}`);
  try {
    const s = JSON.parse(open(url.searchParams.get("state") ?? "")) as { tid: string; t: number };
    if (!s.tid || Date.now() - s.t > 15 * 60_000) throw new Error("This Google sign-in link expired — press Connect Google Business again");
    const code = url.searchParams.get("code");
    if (!code) throw new Error("Google did not send a code");
    const tokens = await googleBusinessExchangeCode(code);
    // The open store; closed or suspended old locations are never posted to.
    const location = (await googleBusinessLocations(tokens.access)).find((l) => l.open);
    if (!location) throw new Error("No open store location on this Google account");
    await pool.query(`DELETE FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'google_business'`, [s.tid]);
    await pool.query(
      `INSERT INTO marketing_channels (tenant_id, provider, account_id, name, status, secret, last_ok_at) VALUES ($1::uuid, 'google_business', $2, $3, 'connected', $4, now())`,
      [s.tid, location.path, `${location.title}${location.address ? ` · ${location.address}` : ""}`, seal(JSON.stringify({ refresh: tokens.refresh, clientId: tokens.clientId, clientSecret: tokens.clientSecret }))],
    );
    return back("google=connected");
  } catch (e) {
    return back(`google=${encodeURIComponent(e instanceof Error ? e.message : "sign-in failed")}`);
  }
}

export const GET = withActivity("marketing/channels/google-business/callback", GET_handler);
