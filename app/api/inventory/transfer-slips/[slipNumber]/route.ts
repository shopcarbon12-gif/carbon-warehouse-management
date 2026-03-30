import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getTransferSlip, getTransferSlipExportRows } from "@/lib/queries/transfer-slips";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slipNumber: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { slipNumber: raw } = await ctx.params;
  const slipNumber = Number.parseInt(raw, 10);
  if (!Number.isFinite(slipNumber)) {
    return NextResponse.json({ error: "Invalid slip number" }, { status: 400 });
  }

  const url = new URL(req.url);
  const exportCsv = url.searchParams.get("export") === "csv";

  try {
    if (exportCsv) {
      const rows = await getTransferSlipExportRows(pool, session.tid, slipNumber);
      if (rows.length === 0) {
        const slip = await getTransferSlip(pool, session.tid, slipNumber);
        if (!slip) return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      return NextResponse.json({ slipNumber, rows }, { headers: { "Cache-Control": "no-store" } });
    }
    const slip = await getTransferSlip(pool, session.tid, slipNumber);
    if (!slip) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(slip, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[transfer-slips/slip GET]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
