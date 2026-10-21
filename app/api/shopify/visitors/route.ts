/**
 * GET /api/shopify/visitors — Shopify → Visitors list: everyone recorded, or
 * only who is on the store now (?view=live); ?filter=, ?q=, ?offset=. Admin only.
 */
import { NextResponse } from "next/server";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { FILTERS, listVisitors, type VisitorFilter } from "@/lib/server/visitors/report";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  const u = new URL(req.url);
  const f = u.searchParams.get("filter") ?? "all";
  const filter: VisitorFilter = (FILTERS as readonly string[]).includes(f) ? (f as VisitorFilter) : "all";
  const offset = Math.max(0, Math.min(100_000, Number(u.searchParams.get("offset")) || 0));
  try {
    const list = await listVisitors(g.pool, {
      live: u.searchParams.get("view") === "live",
      filter,
      q: (u.searchParams.get("q") ?? "").slice(0, 100),
      offset,
      limit: 100,
    });
    return NextResponse.json(list, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load visitors" }, { status: 500 });
  }
}
