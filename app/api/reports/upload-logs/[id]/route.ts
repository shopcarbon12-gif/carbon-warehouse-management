import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getDeviceUploadLogCsv } from "@/lib/queries/device-upload-logs";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSessionFromRequest(_req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id: raw } = await ctx.params;
  const id = Number.parseInt(raw, 10);
  if (!Number.isFinite(id) || id < 1) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  try {
    const row = await getDeviceUploadLogCsv(pool, session.tid, id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const filename = `upload-${id}-${row.workflow_mode.replace(/\s+/g, "_")}.csv`;
    return new NextResponse(row.raw_csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[reports/upload-logs/id]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
