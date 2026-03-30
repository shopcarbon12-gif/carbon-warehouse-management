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
          ? "Cannot connect to PostgreSQL. Check DATABASE_URL (internal host, database name, and password from your Coolify Postgres resource), save, and redeploy."
          : "Cannot reach PostgreSQL. Start it (e.g. docker compose up -d), then npm run db:migrate && npm run db:seed.";
      return NextResponse.json({ error }, { status: 503 });
    }
    const pgCode = (e as { code?: string })?.code;
    if (pgCode === "42P01" || pgCode === "42703") {
      const error =
        process.env.NODE_ENV === "production"
          ? "Database schema is missing or outdated. Run migrations on the server (e.g. npm run db:migrate in deploy) and ensure DATABASE_URL points at the correct database."
          : "Database schema is missing or outdated. Run npm run db:migrate && npm run db:seed.";
      return NextResponse.json({ error }, { status: 503 });
    }
    return NextResponse.json({ error: "Login temporarily unavailable" }, { status: 503 });
  }

  if (!payload) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  let token: string;
  try {
    token = await signSession(payload);
  } catch (e) {
    console.error("[login] signSession", e);
    const error =
      process.env.NODE_ENV === "production"
        ? "Session signing failed. Set SESSION_SECRET to a long random string (32+ characters) in Coolify and redeploy."
        : "Session signing failed. Set SESSION_SECRET in .env.";
    return NextResponse.json({ error }, { status: 503 });
  }
  const mobileClient = req.headers.get("x-carbon-mobile") === "1";
  const res = NextResponse.json({
    ok: true,
    bypassDeviceLock: Boolean(payload.bypassDeviceLock),
    ...(mobileClient ? { token } : {}),
  });
  res.cookies.set("wms_session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
    secure: secureCookie,
  });
  return res;
}
