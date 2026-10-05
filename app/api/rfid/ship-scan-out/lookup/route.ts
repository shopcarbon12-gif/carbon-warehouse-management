import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { cleanEpcs, lookupItems } from "@/lib/server/scan-out";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { epcs } → the item behind each tag the Scan-out reader saw, with its status. */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { epcs?: string[] };
  return NextResponse.json({ items: await lookupItems(pool, cleanEpcs(body.epcs, 500)) });
}
