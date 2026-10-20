/**
 * GET /api/shopify/welcome-popup — the Email Popup page (settings, signups,
 * codes used, the store's automatic discounts the codes compete with). Admin only.
 */
import { NextResponse } from "next/server";
import { welcomeAdminGuard } from "@/lib/server/welcome/guard";
import { getWelcomeReport } from "@/lib/server/welcome/report";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await welcomeAdminGuard(req);
  if ("error" in g) return g.error;
  try {
    return NextResponse.json(await getWelcomeReport(g.pool), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load the email popup" }, { status: 500 });
  }
}
