/**
 * GET /api/shopify/visitors/live?ids=a,b — which of these visitors are still on
 * shopcarbon.com. The WMS alert cards (components/wms-alerts.tsx) ask this and
 * close the alert of a visitor who left (owner 2026-10-22). Admin only.
 */
import { NextResponse } from "next/server";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { stillLive } from "@/lib/server/visitors/report";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  const ids = (new URL(req.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[\w-]{1,64}$/.test(s))
    .slice(0, 50);
  try {
    return NextResponse.json({ live: await stillLive(g.pool, ids) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not check visitors" }, { status: 500 });
  }
}
