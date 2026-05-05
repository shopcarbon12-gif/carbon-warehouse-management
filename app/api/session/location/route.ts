import { NextResponse } from "next/server";
import { sessionCookieSecure, signSession } from "@/lib/auth";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { withDb } from "@/lib/db";
import { assertLocationForTenant } from "@/lib/queries/session-user";

/**
 * Switch the active location for the current session and mint a fresh JWT
 * scoped to the new lid. Web sessions get the new token via cookie; mobile
 * clients (Bearer auth) also receive the token in the response body so
 * they can persist it via setSessionToken().
 *
 * Auth: cookie OR Bearer — whichever the caller used to reach this route.
 * The proxy.ts catch-all has already validated one of them; we just decode
 * the same payload here and re-sign with the new lid.
 */
export async function POST(req: Request) {
  const cur = await getSessionFromRequest(req);
  if (!cur) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { locationId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const locationId = body.locationId?.trim();
  if (!locationId) {
    return NextResponse.json({ error: "locationId required" }, { status: 400 });
  }

  const allowed = await withDb(
    (sql) =>
      assertLocationForTenant(
        sql,
        cur.tid,
        locationId,
        isAdminRole(cur.role ?? "") ? undefined : cur.sub,
      ),
    false,
  );
  if (!allowed) {
    return NextResponse.json({ error: "Invalid location" }, { status: 403 });
  }

  const nextPayload = { ...cur, lid: locationId };
  const token = await signSession(nextPayload);
  const mobileClient = req.headers.get("x-carbon-mobile") === "1";
  const res = NextResponse.json({
    ok: true,
    locationId,
    ...(mobileClient ? { token } : {}),
  });
  res.cookies.set("wms_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: sessionCookieSecure(req),
  });
  return res;
}
