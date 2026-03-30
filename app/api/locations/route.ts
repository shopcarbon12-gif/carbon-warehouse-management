import { NextResponse } from "next/server";
import { isAdminRole } from "@/lib/auth/dashboard-rbac";
import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { listLocationsForTenant } from "@/lib/queries/locations";

export async function GET() {
  const session = await getSession();
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
