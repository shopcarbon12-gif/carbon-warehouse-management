import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { withDb } from "@/lib/db";
import { listBinContentsGrouped } from "@/lib/queries/locations";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const binId = new URL(req.url).searchParams.get("binId")?.trim() ?? "";
  if (!UUID_RE.test(binId)) {
    return NextResponse.json({ error: "Invalid binId" }, { status: 400 });
  }

  const rows = await withDb(
    (pool) => listBinContentsGrouped(pool, session.lid, binId),
    [],
  );
  return NextResponse.json(rows);
}
