import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { binActorFrom } from "@/lib/server/bin-engine";
import { canChangeZones, deleteZone, renameZone } from "@/lib/server/assigned-zones";
import { zoneError } from "@/lib/server/zone-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const Body = z.object({ name: z.string().trim().min(1).max(60) });

/** PATCH { name } → rename. */
async function PATCH_handler(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid zone" }, { status: 400 });
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
    const r = await renameZone(client, session.tid, session.lid, id, parsed.data.name);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return zoneError(e, "assigned-zones PATCH");
  } finally {
    client.release();
  }
}

/** DELETE → the zone's tags lose it (history per tag), the zone is archived. */
async function DELETE_handler(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid zone" }, { status: 400 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  if (!(await canChangeZones(pool, session, "manage"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await deleteZone(client, session.tid, session.lid, id, binActorFrom(req, session));
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    return zoneError(e, "assigned-zones DELETE");
  } finally {
    client.release();
  }
}

export const PATCH = withActivity("assigned-zones/[id]", PATCH_handler);
export const DELETE = withActivity("assigned-zones/[id]", DELETE_handler);
