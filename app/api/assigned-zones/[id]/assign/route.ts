import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { binActorFrom } from "@/lib/server/bin-engine";
import { assignEpcsToZone, canChangeZones, writeZoneReport } from "@/lib/server/assigned-zones";
import { zoneError } from "@/lib/server/zone-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({
  epcs: z.array(z.string().min(1).max(64)).min(1).max(5000),
  deviceId: z.string().max(256).nullish(),
});

/**
 * POST { epcs } → assigns the LIVE tags of this location to the zone (moving
 * them from another zone). Send the whole scan: every tag is in the report. Reply: { assigned, moved, alreadyInZone, skipped:
 * [{ epc, reason, reasonText, details }] } — every tag that couldn't be
 * assigned, why, and everything the WMS knows about it.
 */
async function POST_handler(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid zone" }, { status: 400 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  if (!(await canChangeZones(pool, session, "assign"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const actor = binActorFrom(req, session, parsed.data.deviceId);
    const r = await assignEpcsToZone(pool, client, session.tid, session.lid, id, parsed.data.epcs, actor);
    // The whole scan — couldn't-assign tags included — becomes a report
    // (Reports → Device Upload Logs; handheld Reports → Zones).
    const reportId = await writeZoneReport(client, session.tid, actor.deviceId, "assign", r.zone, r.lines);
    await client.query("COMMIT");
    const { lines: _lines, ...rest } = r;
    void _lines;
    return NextResponse.json({ ok: true, ...rest, reportId });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return zoneError(e, "assigned-zones assign");
  } finally {
    client.release();
  }
}

export const POST = withActivity("assigned-zones/[id]/assign", POST_handler);
