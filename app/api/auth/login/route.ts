import { NextResponse } from "next/server";
import { sessionCookieSecure, signSession } from "@/lib/auth";
import { getPool, isDatabaseUnreachable } from "@/lib/db";
import { findUserWithTenantLocation } from "@/lib/queries/session-user";

export async function POST(req: Request) {
  const secureCookie = sessionCookieSecure(req);
  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = body.email?.trim();
  const password = body.password ?? "";
  if (!email || !password) {
    return NextResponse.json({ error: "Email and password required" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    const error =
      process.env.NODE_ENV === "production"
        ? "DATABASE_URL is not set on the server. In Coolify: WMS app → Environment variables → add DATABASE_URL (use the internal URL from your linked PostgreSQL resource), save, then redeploy."
        : "DATABASE_URL is not set. Copy .env.example to .env.";
    return NextResponse.json({ error }, { status: 503 });
  }

  let payload;
  try {
    payload = await findUserWithTenantLocation(pool, email, password);
  } catch (e) {
    console.error("[login]", e);
    if (isDatabaseUnreachable(e)) {
      const error =
        process.env.NODE_ENV === "production"
          ? "Cannot reach PostgreSQL. Verify DATABASE_URL in Coolify and that the database container is running."
          : "Cannot reach PostgreSQL. Start it (e.g. docker compose up -d), then npm run db:migrate && npm run db:seed.";
      return NextResponse.json({ error }, { status: 503 });
    }
    return NextResponse.json({ error: "Login temporarily unavailable" }, { status: 503 });
  }

  if (!payload) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const token = await signSession(payload);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("wms_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: secureCookie,
  });
  return res;
}
