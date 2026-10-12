/**
 * Store Replenishment (handheld): completed POS sales of the showroom at the
 * caller's location, newest first. ?fromDate=&toDate= (YYYY-MM-DD, store-local,
 * inclusive; default = today in the store's time zone). See
 * lib/server/store-replenishment.ts.
 */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { listReplenishmentSales } from "@/lib/server/store-replenishment";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const sp = new URL(req.url).searchParams;
  const instant = (v: string | null) => (v && !Number.isNaN(Date.parse(v)) ? v : null);
  const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  try {
    // fromDate/toDate = store-local days (default: today in Orlando);
    // from/to = instants, still sent by 1.2.163 handhelds.
    const sales = await listReplenishmentSales(pool, session.lid, {
      from: instant(sp.get("from")),
      to: instant(sp.get("to")),
      fromDate: day(sp.get("fromDate")),
      toDate: day(sp.get("toDate")),
    });
    return NextResponse.json({ sales }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[store-replenishment/sales]", e);
    return NextResponse.json({ error: "Could not load sales" }, { status: 500 });
  }
}
