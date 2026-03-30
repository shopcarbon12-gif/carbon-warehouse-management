import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { sessionCookieSecure, signSession, verifySessionToken } from "@/lib/auth";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { withDb } from "@/lib/db";
import { assertLocationForTenant } from "@/lib/queries/session-user";

export async function POST(req: Request) {
  const jar = await cookies();
  const raw = jar.get("wms_session")?.value;
  if (!raw) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cur = await verifySessionToken(raw);
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
  const res = NextResponse.json({ ok: true });
  res.cookies.set("wms_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: sessionCookieSecure(req),
  });
  return res;
}
