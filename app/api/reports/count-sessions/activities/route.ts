import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { listCountSessionActivities } from "@/lib/queries/inventory-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { searchParams } = new URL(req.url);
  const hintedDeviceId = searchParams.get("deviceId") ?? undefined;

  const auth = await resolveTenantOrError(req, pool, hintedDeviceId);
  if (auth instanceof Response) return auth;

  try {
    const activities = await listCountSessionActivities(pool, auth.tenantId);
    return NextResponse.json(activities, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[reports/count-sessions/activities GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
