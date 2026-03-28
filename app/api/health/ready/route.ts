import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

/**
 * Readiness: verifies DATABASE_URL and a simple `select 1`. Use for manual checks or
 * a separate Coolify probe if you want DB-aware health (not for Docker HEALTHCHECK).
 */
export async function GET() {
  const sql = getSql();
  if (!sql) {
    return NextResponse.json(
      { ok: true, db: "skipped", hint: "DATABASE_URL not set" },
      { status: 200 },
    );
  }
  try {
    await sql`select 1`;
    return NextResponse.json({ ok: true, db: "up" });
  } catch {
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}
