/**
 * Shopify → Sales list, read live (lib/server/shopify-sales.ts). Admin only:
 * it carries customer names and money.
 *
 *   GET ?tab=all|unfulfilled|unpaid|open|archived&q=…&after=…|before=…
 *   GET ?today=1&tz=America/New_York  → the "Today" bar
 *   GET ?badge=1                      → { toFulfill, orders } for the menu badge and home notice
 */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { SALES_TABS, ShopifyNotConnected, listSales, salesToday, toFulfill, type SalesTab } from "@/lib/server/shopify-sales";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const url = new URL(req.url);
  try {
    if (url.searchParams.get("badge")) {
      const t = await toFulfill();
      return NextResponse.json({ toFulfill: t.count, orders: t.orders });
    }
    if (url.searchParams.get("today")) {
      const tz = url.searchParams.get("tz") || "America/New_York";
      return NextResponse.json(await salesToday(tz));
    }
    const tabParam = (url.searchParams.get("tab") || "all") as SalesTab;
    const tab = SALES_TABS.includes(tabParam) ? tabParam : "all";
    const page = await listSales({
      tab,
      search: (url.searchParams.get("q") || "").slice(0, 200),
      after: url.searchParams.get("after"),
      before: url.searchParams.get("before"),
    });
    return NextResponse.json(page);
  } catch (e) {
    if (e instanceof ShopifyNotConnected) return NextResponse.json({ error: e.message }, { status: 503 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load sales from Shopify." }, { status: 502 });
  }
}
