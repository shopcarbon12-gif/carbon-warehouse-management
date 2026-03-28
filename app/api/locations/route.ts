import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { withDb } from "@/lib/db";
import { listLocationsForTenant } from "@/lib/queries/locations";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rows = await withDb(
    (sql) => listLocationsForTenant(sql, session.tid),
    [],
  );
  return NextResponse.json(rows);
}
