import { NextResponse } from "next/server";
import { withDb } from "@/lib/db";
import { listRecentSyncRuns } from "@/lib/queries/sync";

export async function GET() {
  const runs = await withDb((pool) => listRecentSyncRuns(pool, 30), []);
  return NextResponse.json({ runs });
}
