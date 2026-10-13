import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { buildQueue } from "@/lib/server/grading-app";

export const dynamic = "force-dynamic";

/** GET → catalogue progress, the cut and size combinations still to measure, and the scans that need a look. */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const limit = Number(new URL(req.url).searchParams.get("limit") || 60);
  return NextResponse.json(await buildQueue(pool, Number.isFinite(limit) ? limit : 60));
}
