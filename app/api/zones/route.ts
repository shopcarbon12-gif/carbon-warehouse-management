import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { listZonesForTenant, upsertZone, upsertZoneSchema } from "@/lib/server/zones";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }
  try {
    // Scope to active location so users on FL Mall don't see Orlando's
    // zones in the hardware-config UI.
    const zones = await listZonesForTenant(pool, session.tid, session.lid);
    return NextResponse.json({ zones }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[zones GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = upsertZoneSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: first?.message ?? "Invalid body", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  // body.locationId must match the active location on the session.
  if (
    session.lid &&
    parsed.data.locationId &&
    parsed.data.locationId !== session.lid
  ) {
    return NextResponse.json(
      { error: "locationId must match your active location" },
      { status: 403 },
    );
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = await upsertZone(client, session.tid, parsed.data);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, id });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Save failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[zones POST]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
