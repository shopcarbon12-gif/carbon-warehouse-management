import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { sessionCookieName } from "@/lib/auth";

async function POST_handler() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookieName(), "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}

export const POST = withActivity("auth/logout", POST_handler);
