import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { listMissingCoreTables } from "@/lib/server/wms-core-schema";

/**
 * Readiness: `SELECT 1` + required `public` tables (`locations`, `bins`, `tenants`, `users`).
 * Use for manual checks or a Coolify probe — **not** for Docker HEALTHCHECK (see /api/health).
 *
 * Returns **503** when the DB answers but WMS tables are missing (common when `psql` migrations
 * failed silently or `DATABASE_URL` points at the wrong/empty database).
 */
export async function GET() {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json(
      { ok: true, db: "skipped", hint: "DATABASE_URL not set" },
      { status: 200 },
    );
  }
  try {
    await pool.query("SELECT 1");
  } catch {
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }

  try {
    const missing = await listMissingCoreTables(pool);
    if (missing.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          db: "up",
          schema: "incomplete",
          missing_tables: missing,
          hint:
            "Postgres is reachable but WMS tables are missing. In Coolify: set WMS_AUTO_MIGRATE=1, redeploy, read container logs for wms: WARNING (psql) or CRITICAL (missing tables). Confirm DATABASE_URL is the linked Postgres for this app (correct database name).",
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ ok: true, db: "up", schema: "ok" });
  } catch {
    return NextResponse.json(
      { ok: false, db: "up", schema: "check_failed" },
      { status: 503 },
    );
  }
}
