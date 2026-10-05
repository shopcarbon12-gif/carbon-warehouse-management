import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listScanOutEvents } from "@/lib/server/scan-out";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const csv = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** GET ?q=…&format=csv — Reports → Scan-out log. */
export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const url = new URL(req.url);
  const rows = await listScanOutEvents(pool, session.tid, { search: url.searchParams.get("q") ?? "", limit: 2000 });
  if (url.searchParams.get("format") === "csv") {
    const cols = ["at", "user", "action", "orderName", "epc", "oldStatus", "newStatus", "sku", "upc", "name", "color", "size", "bin", "reader", "rssi", "detail"] as const;
    const body = [cols.join(","), ...rows.map((r) => cols.map((c) => csv(r[c])).join(","))].join("\n");
    return new NextResponse(body, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="scan-out-log.csv"` },
    });
  }
  return NextResponse.json({ rows });
}
