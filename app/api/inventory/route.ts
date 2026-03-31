import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { withDb } from "@/lib/db";
import { listInventory } from "@/lib/queries/inventory";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q") ?? undefined;
  const zone = searchParams.get("zone") ?? undefined;
  const limit = Math.min(Number(searchParams.get("limit") ?? 50), 200);
  const offset = Math.max(Number(searchParams.get("offset") ?? 0), 0);

  const rows = await withDb(
    (sql) =>
      listInventory(sql, session.lid, { q, zone, limit, offset }),
    [],
  );
  return NextResponse.json(rows);
}
