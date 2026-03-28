import { NextResponse } from "next/server";
import { signSession } from "@/lib/auth";
import { getSql, isDatabaseUnreachable } from "@/lib/db";
import { findUserWithTenantLocation } from "@/lib/queries/session-user";

export async function POST(req: Request) {
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

  const sql = getSql();
  if (!sql) {
    return NextResponse.json(
      { error: "DATABASE_URL is not set. Copy .env.example to .env." },
      { status: 503 },
    );
  }

  let payload;
  try {
    payload = await findUserWithTenantLocation(sql, email, password);
  } catch (e) {
    console.error("[login]", e);
    if (isDatabaseUnreachable(e)) {
      return NextResponse.json(
        {
          error:
            "Cannot reach PostgreSQL. Start it (e.g. docker compose up -d), then npm run db:migrate && npm run db:seed.",
        },
        { status: 503 },
      );
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
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
