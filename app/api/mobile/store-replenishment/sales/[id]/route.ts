/**
 * Store Replenishment (handheld): one sale's item lines — SKU, name, colour,
 * size, bin, price, sold quantity, LIVE stock at the caller's location, and
 * whether the line has been picked. Lines with stock come first.
 */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getReplenishmentLines } from "@/lib/server/store-replenishment";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!/^\d{1,10}$/.test(id)) return NextResponse.json({ error: "Bad sale id" }, { status: 400 });
  try {
    const r = await getReplenishmentLines(pool, session.lid, Number(id));
    if (!r.sale) return NextResponse.json({ error: "Sale not found" }, { status: 404 });
    return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[store-replenishment/sale]", e);
    return NextResponse.json({ error: "Could not load the sale" }, { status: 500 });
  }
}
