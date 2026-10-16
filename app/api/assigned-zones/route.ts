import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { canChangeZones, createZone, listZones } from "@/lib/server/assigned-zones";
import { zoneError } from "@/lib/server/zone-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Zone Management (assigned zones — per EPC, by scanning). Not /api/zones,
 * which is the fixed readers' zones.
 *   GET  → zones at the session location with their LIVE tag counts
 *   POST { name } → create a zone
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  try {
    const zones = await listZones(pool, session.tid, session.lid);
    return NextResponse.json({ zones, canManage: await canChangeZones(pool, session, "manage") });
  } catch (e) {
    return zoneError(e, "assigned-zones GET");
  }
}

const Body = z.object({ name: z.string().trim().min(1).max(60) });

async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Zone name is required" }, { status: 400 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  if (!(await canChangeZones(pool, session, "manage"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const zone = await createZone(client, session.tid, session.lid, parsed.data.name, session.sub);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, zone });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return zoneError(e, "assigned-zones POST");
  } finally {
    client.release();
  }
}

export const POST = withActivity("assigned-zones", POST_handler);
