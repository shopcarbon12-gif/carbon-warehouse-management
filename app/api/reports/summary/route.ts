import { NextResponse } from "next/server";
import { withDb } from "@/lib/db";
import { emptyReportSummary, getReportSummary } from "@/lib/queries/reports";

export async function GET() {
  const data = await withDb((pool) => getReportSummary(pool), emptyReportSummary());
  return NextResponse.json(data);
}
