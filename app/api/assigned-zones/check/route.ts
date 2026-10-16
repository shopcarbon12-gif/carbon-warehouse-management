import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { checkEpcsForZone } from "@/lib/server/assigned-zones";
import { zoneError } from "@/lib/server/zone-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ epcs: z.array(z.string().min(1).max(64)).min(1).max(2000) });

/**
 * POST { epcs } → per tag: ok (LIVE here — can be assigned) or the reason it
 * can't (not LIVE / other location / not in the WMS / not a Carbon tag /
 * damaged-chip read / re-encoded old number), plus every detail of the tag.
 * Read-only; the handheld calls it while scanning to fill its list.
 */
export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    return NextResponse.json({ rows: await checkEpcsForZone(pool, session.tid, session.lid, parsed.data.epcs) });
  } catch (e) {
    return zoneError(e, "assigned-zones check");
  }
}
