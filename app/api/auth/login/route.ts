import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { sessionCookieSecure, signSession } from "@/lib/auth";
import { getPool, isDatabaseUnreachable } from "@/lib/db";
import { findUserWithTenantLocation } from "@/lib/queries/session-user";

// Lightweight in-memory brute-force throttle, keyed by client IP + email.
// Per-instance and reset on restart; an upstream WAF/proxy limit is the real
// defence at scale, but this stops trivially unthrottled password guessing.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: Request): string {
  // Use the LAST X-Forwarded-For entry — the one our own proxy (Traefik) appends
  // from the real TCP peer — not the first, which the client can spoof to rotate
  // past the throttle. Falls back to X-Real-Ip (also proxy-set).
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

function registerAttempt(key: string): boolean {
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    if (loginAttempts.size > 5000) {
      for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
    }
    return false;
  }
  rec.count += 1;
  return rec.count > LOGIN_MAX_ATTEMPTS;
}

async function POST_handler(req: Request) {
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

  const rlKey = `${clientIp(req)}:${email.toLowerCase()}`;
  if (registerAttempt(rlKey)) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Wait a few minutes and try again." },
      { status: 429 },
    );
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
  // Successful login clears the throttle so a legitimate user isn't locked out.
  loginAttempts.delete(rlKey);
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

export const POST = withActivity("auth/login", POST_handler);
