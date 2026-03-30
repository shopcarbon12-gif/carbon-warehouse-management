import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { cleanBinContents } from "@/lib/queries/clean-bin";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Invalid bin id" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await cleanBinContents(client, session.tid, id);
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
