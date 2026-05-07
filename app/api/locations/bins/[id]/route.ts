import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { assertRowLocation } from "@/lib/server/assert-row-location";
import { archiveBin } from "@/lib/server/overview-locations";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(_req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid bin id" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  // Active-location guard.
  const guard = await assertRowLocation(pool, "bins", id, session.tid, session.lid);
  if (guard === "not_found")
    return NextResponse.json({ error: "Bin not found" }, { status: 404 });
  if (guard === "wrong_location")
    return NextResponse.json({ error: "Wrong location for this bin" }, { status: 403 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await archiveBin(client, session.tid, id);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Archive failed";
    if (msg.startsWith("BAD_REQUEST:")) {
      return NextResponse.json({ error: msg.slice(12) }, { status: 400 });
    }
    console.error("[locations/bins DELETE]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
