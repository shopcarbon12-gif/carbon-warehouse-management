import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { assertRowLocation } from "@/lib/server/assert-row-location";
import { cleanBinContents } from "@/lib/queries/clean-bin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid bin id" }, { status: 400 });
  }

  let skuPrefix: string | undefined;
  try {
    const body = (await req.json().catch(() => ({}))) as { skuPrefix?: unknown };
    if (typeof body.skuPrefix === "string") {
      const p = body.skuPrefix.trim();
      // Accept 7–32 alphanumeric chars (matrix/color prefix range).
      if (p && /^[A-Za-z0-9]{7,32}$/.test(p)) skuPrefix = p;
    }
  } catch {
    /* no body — clean all (legacy behaviour) */
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  // Active-location guard.
  const guard = await assertRowLocation(pool, "bins", id, session.tid, session.lid);
  if (guard === "not_found")
    return NextResponse.json({ error: "Bin not found" }, { status: 404 });
  if (guard === "wrong_location")
    return NextResponse.json({ error: "Wrong location for this bin" }, { status: 403 });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await cleanBinContents(client, session.tid, id, skuPrefix);
    await client.query("COMMIT");
    return NextResponse.json({ ok: true, cleared: result.cleared });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Clean failed";
    if (msg === "NOT_FOUND") {
      return NextResponse.json({ error: "Bin not found" }, { status: 404 });
    }
    console.error("[bins/clean]", e);
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    client.release();
  }
}
