import { NextResponse } from "next/server";
import { getSession } from "@/lib/get-session";
import { getPool } from "@/lib/db";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(req: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const customSkuId = new URL(req.url).searchParams.get("customSkuId")?.trim() ?? "";
  if (!UUID_RE.test(customSkuId)) {
    return NextResponse.json({ error: "Invalid customSkuId" }, { status: 400 });
  }

  const pool = getPool();
  if (!pool) {
    return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  }

  const r = await pool.query<{ m: string }>(
    `SELECT coalesce(max(serial_number), 0)::text AS m
     FROM items
     WHERE custom_sku_id = $1::uuid AND location_id = $2::uuid`,
    [customSkuId, session.lid],
  );
  const next = Number(r.rows[0]?.m ?? 0) + 1;
  return NextResponse.json({ next_serial: next }, { headers: { "Cache-Control": "no-store" } });
}
