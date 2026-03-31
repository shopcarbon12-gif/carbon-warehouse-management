import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { SCOPES, scopesForMembershipRole } from "@/lib/auth/roles";
import { getMembershipRole } from "@/lib/queries/membership-role";
import { getTrackerItemByEpc } from "@/lib/server/rfid-tracker";

export const dynamic = "force-dynamic";

/**
 * Rich identity card for handheld: one EPC → SKU, description, bin, status, location.
 */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const role = (await getMembershipRole(pool, session.sub, session.tid)) ?? "member";
  const granted = scopesForMembershipRole(role);
  if (!granted.has(SCOPES.MANAGER) && !granted.has(SCOPES.WAREHOUSE_OPS)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const epc = new URL(req.url).searchParams.get("epc")?.trim() ?? "";
  if (epc.length < 4) {
    return NextResponse.json({ error: "epc query required" }, { status: 400 });
  }

  try {
    const row = await getTrackerItemByEpc(pool, session.tid, epc);
    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ item: row }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[mobile/item-detail]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
