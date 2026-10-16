import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { binActorFrom } from "@/lib/server/bin-engine";
import { canChangeZones, removeEpcsFromZone, writeZoneReport } from "@/lib/server/assigned-zones";
import { zoneError } from "@/lib/server/zone-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  epcs: z.array(z.string().min(1).max(64)).min(1).max(5000),
  /** Only take the tags out of this zone (default: whatever zone they're in). */
  zoneId: z.string().uuid().nullish(),
  deviceId: z.string().max(256).nullish(),
});

/** POST { epcs } → takes the zone off those tags. Bins are never touched. */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
    const r = await removeEpcsFromZone(
      pool,
      client,
      session.tid,
      session.lid,
      parsed.data.epcs,
      actor,
      parsed.data.zoneId ?? null,
    );
    let zoneName = "any zone";
    if (parsed.data.zoneId) {
      const z = await client.query<{ name: string }>(`SELECT name FROM assigned_zones WHERE id = $1::uuid`, [parsed.data.zoneId]);
      zoneName = z.rows[0]?.name ?? zoneName;
    }
    const reportId = await writeZoneReport(client, session.tid, actor.deviceId, "remove", zoneName, r.lines);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, removed: r.removed, notInZone: r.notInZone, reportId });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return zoneError(e, "assigned-zones remove");
  } finally {
    client.release();
  }
}

export const POST = withActivity("assigned-zones/remove", POST_handler);
