import { NextResponse } from "next/server";
import { SCOPES } from "@/lib/auth/roles";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { upsertReader, upsertReaderSchema } from "@/lib/server/cdm-devices";

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

  const parsed = upsertReaderSchema.safeParse(json);
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

  // Active-location guard: when creating, the supplied zone must belong to
  // the caller's active location; when updating, the existing device must.
  if (session.lid) {
    if (parsed.data.zoneId) {
      const z = await pool.query<{ location_id: string }>(
        `SELECT location_id::text FROM zones
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [parsed.data.zoneId, session.tid],
      );
      if (z.rowCount === 0)
        return NextResponse.json({ error: "Zone not found" }, { status: 404 });
      if (z.rows[0].location_id !== session.lid)
        return NextResponse.json(
          { error: "Zone is at a different location than your active one" },
          { status: 403 },
        );
    } else if (parsed.data.id) {
      const d = await pool.query<{ location_id: string }>(
        `SELECT location_id::text FROM devices
          WHERE id = $1::uuid AND tenant_id = $2::uuid`,
        [parsed.data.id, session.tid],
      );
      if (d.rowCount === 0)
        return NextResponse.json({ error: "Reader not found" }, { status: 404 });
      if (d.rows[0].location_id !== session.lid)
        return NextResponse.json(
          { error: "Wrong location for this resource" },
          { status: 403 },
        );
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { id } = await upsertReader(client, session.tid, parsed.data);
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
    console.error("[hardware-config/readers POST]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
