import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";
import { getCountSessionReportCsv } from "@/lib/queries/inventory-reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const { searchParams } = new URL(req.url);
  const hintedDeviceId = searchParams.get("deviceId") ?? undefined;

  const auth = await resolveTenantOrError(req, pool, hintedDeviceId);
  if (auth instanceof Response) return auth;

  try {
    const found = await getCountSessionReportCsv(pool, auth.tenantId, id);
    if (!found) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // UTF-8, no BOM, attachment disposition.
    return new NextResponse(found.csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${found.filename.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[reports/count-sessions/[id]/download]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
