/**
 * Starts Lightspeed R-Series OAuth (merchantos authorize) — same pattern as carbon-gen `/api/lightspeed/auth`.
 * After consent, Lightspeed redirects the browser to `/api/lightspeed/callback` with `code`.
 */
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SCOPES = "employee:all";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function publicAppBase(): string {
  const fromEnv =
    normalizeText(process.env.WMS_APP_PUBLIC_BASE_URL) ||
    normalizeText(process.env.NEXT_PUBLIC_BASE_URL) ||
    normalizeText(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return fromEnv.replace(/\/$/, "") || "http://localhost:3000";
}

export async function GET() {
  const clientId = normalizeText(process.env.LS_CLIENT_ID);
  const base = publicAppBase();
  const redirectUri =
    normalizeText(process.env.LS_REDIRECT_URI) || `${base}/api/lightspeed/callback`;

  if (!clientId) {
    return NextResponse.redirect(`${base}/infrastructure/settings?ls_error=missing_client_id`);
  }

  const state = crypto.randomUUID();
  const cookieStore = await cookies();
  cookieStore.set("ls_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
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
