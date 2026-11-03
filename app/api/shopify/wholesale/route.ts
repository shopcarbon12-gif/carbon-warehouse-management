/**
 * GET /api/shopify/wholesale — Shopify → Wholesale: the applications sent from
 * the Wholesale page, newest waiting ones first. `?count=1` answers only how
 * many are waiting (the menu badge). Admin only, like the rest of the Shopify menu.
 */
import { NextResponse } from "next/server";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { listApplications } from "@/lib/server/wholesale/applications";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  try {
    if (new URL(req.url).searchParams.get("count") === "1") {
      const r = await g.pool.query<{ n: string }>(`SELECT count(*) AS n FROM wholesale_applications WHERE status = 'new'`);
      return NextResponse.json({ count: Number(r.rows[0]?.n ?? 0) }, { headers: { "Cache-Control": "no-store" } });
    }
    return NextResponse.json(await listApplications(g.pool), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load wholesale applications" }, { status: 500 });
  }
}
