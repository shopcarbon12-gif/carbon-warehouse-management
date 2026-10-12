/**
 * Store Replenishment (handheld): completed POS sales of the showroom at the
 * caller's location, newest first. ?from=&to= (ISO instants); default = the
 * last 30 days. See lib/server/store-replenishment.ts.
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
  const valid = (v: string | null) => (v && !Number.isNaN(Date.parse(v)) ? v : null);
  const to = valid(sp.get("to")) ?? new Date(Date.now() + 60_000).toISOString();
  const from = valid(sp.get("from")) ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
  try {
    const sales = await listReplenishmentSales(pool, session.lid, { from, to });
    return NextResponse.json({ from, to, sales }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[store-replenishment/sales]", e);
    return NextResponse.json({ error: "Could not load sales" }, { status: 500 });
  }
}
