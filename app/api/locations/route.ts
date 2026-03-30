import { NextResponse } from "next/server";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { withDb } from "@/lib/db";
import { listLocationsForTenant } from "@/lib/queries/locations";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const admin = isAdminRole(session.role ?? "");
  const rows = await withDb(
    (sql) =>
      listLocationsForTenant(sql, session.tid, {
        userId: session.sub,
        bypassUserLocationFilter: admin,
      }),
    [],
  );
  return NextResponse.json(rows);
}
