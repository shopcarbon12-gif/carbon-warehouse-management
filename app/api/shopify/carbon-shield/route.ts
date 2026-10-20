/**
 * GET /api/shopify/carbon-shield — the Carbon Shield dashboard (settings,
 * rules, 24 h / 7 day traffic split, reasons, networks, countries, sources,
 * recent flagged visitors, 30-day chart, data status). Admin only.
 */
import { NextResponse } from "next/server";
import { shieldAdminGuard } from "@/lib/server/shield/guard";
import { getShieldReport } from "@/lib/server/shield/report";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await shieldAdminGuard(req);
  if ("error" in g) return g.error;
  try {
    return NextResponse.json(await getShieldReport(g.pool), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load Carbon Shield" }, { status: 500 });
  }
}
