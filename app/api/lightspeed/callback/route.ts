/**
 * Lightspeed OAuth callback — exchanges `code` for tokens (carbon-gen equivalent).
 * Shows a small HTML page with the refresh token to paste into Coolify as `LS_REFRESH_TOKEN`.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { lightspeedOAuthPublicBase } from "@/lib/server/lightspeed-oauth-public-base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  /* carbon-gen reads this from the query for parity (optional Lightspeed hint). */
  void searchParams.get("domain_prefix");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const base = lightspeedOAuthPublicBase();
  const redirectUri =
    String(process.env.LS_REDIRECT_URI || "").trim() || `${base}/api/lightspeed/callback`;

  const cookieStore = await cookies();
  const expectedState = cookieStore.get("ls_oauth_state")?.value;
  cookieStore.delete("ls_oauth_state");

  if (error) {
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=no_code`);
  }
  if (state !== expectedState) {
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=invalid_state`);
  }

  const clientId = String(process.env.LS_CLIENT_ID || "").trim();
  const clientSecret = String(process.env.LS_CLIENT_SECRET || "").trim();
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=missing_credentials`);
  }

  const tokenUrl = "https://cloud.merchantos.com/oauth/access_token.php";
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }).toString();

  const tokenRes = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });

  const data = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!tokenRes.ok) {
    const err = String(data?.error || data?.error_description || tokenRes.status);
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=${encodeURIComponent(err)}`);
  }

  const refreshToken = String(data?.refresh_token || "").trim();
  const scope = String(data?.scope || "");

  if (!refreshToken) {
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=no_refresh_token`);
  }

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Lightspeed connected</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:1rem;line-height:1.5">
<h1>Lightspeed OAuth complete</h1>
<p>Scopes: <code>${esc(scope)}</code></p>
<p>Copy the refresh token into Coolify (or <code>.env</code>) as <strong>LS_REFRESH_TOKEN</strong>, then redeploy if needed.</p>
<label for="tok" style="display:block;font-size:0.85rem;margin-top:1rem">Refresh token</label>
<input id="tok" type="text" readonly value="${esc(refreshToken)}" style="width:100%;padding:10px;font-family:ui-monospace,monospace;font-size:12px;box-sizing:border-box"/>
<p style="margin-top:1rem">
<button type="button" id="copy">Copy token</button>
</p>
<p><a href="${esc(base)}/infrastructure/settings">Back to WMS settings</a></p>
<script>
document.getElementById("copy").onclick=function(){
  var el=document.getElementById("tok");
  el.select();
  navigator.clipboard.writeText(el.value);
};
</script>
</body></html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
