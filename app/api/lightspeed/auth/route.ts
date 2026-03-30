/**
 * Starts Lightspeed R-Series OAuth (merchantos authorize) — same pattern as carbon-gen `/api/lightspeed/auth`.
 * After consent, Lightspeed redirects the browser to `/api/lightspeed/callback` with `code`.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { lightspeedOAuthPublicBase } from "@/lib/server/lightspeed-oauth-public-base";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = "employee:all";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

export async function GET() {
  const clientId = normalizeText(process.env.LS_CLIENT_ID);
  const base = lightspeedOAuthPublicBase();
  const redirectUri =
    normalizeText(process.env.LS_REDIRECT_URI) || `${base}/api/lightspeed/callback`;

  if (!clientId) {
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=missing_client_id`);
  }

  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("ls_oauth_state", state, {
    httpOnly: true,
    /* carbon-gen uses `secure: true` (always HTTPS). WMS: secure only when public base is HTTPS so local http://localhost:3040 OAuth still works. */
    secure: base.startsWith("https://"),
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    scope: SCOPES,
  });

  return NextResponse.redirect(
    `https://cloud.merchantos.com/oauth/authorize.php?${params.toString()}`,
  );
}
