import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listModelProfiles } from "@/lib/server/model-profiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET → every model profile (the people in CARBON's product photos). */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  return NextResponse.json({ profiles: await listModelProfiles(pool) });
}
