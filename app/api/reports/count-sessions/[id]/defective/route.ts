import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveTenantOrError } from "@/lib/auth/resolve-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * GET /api/reports/count-sessions/<id>/defective
 *
 * Downloads the per-report defective EPCs CSV (the column set Q30 locked:
 * epc, scanned_at, decode_reason, raw_decoded_bits, device_id, operator_user_id).
 *
 * Empty 200 with `count: 0` if the report has no failures attached.
 */
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

  const r = await pool.query<{
    defective_csv_blob: string | null;
    defective_row_count: number;
    filename: string;
  }>(
    `SELECT defective_csv_blob, defective_row_count, filename
       FROM inventory_reports
      WHERE id = $1::uuid AND tenant_id = $2::uuid
      LIMIT 1`,
    [id, auth.tenantId],
  );
  const row = r.rows[0];
  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!row.defective_csv_blob) {
    return NextResponse.json(
      { count: 0, csv: null },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const filename = row.filename.replace(/\.csv$/i, "_defective.csv");
  return new NextResponse(row.defective_csv_blob, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Defective-Row-Count": String(row.defective_row_count),
    },
  });
}
