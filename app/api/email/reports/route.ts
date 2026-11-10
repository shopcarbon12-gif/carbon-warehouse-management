/** GET /api/email/reports?days=30 — campaigns and automatic emails: sent, opens, clicks, unsubscribes, orders and sales. */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { emailReport } from "@/lib/server/email/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const days = Number(new URL(req.url).searchParams.get("days") ?? 30) || 30;
  try {
    return NextResponse.json(await emailReport(g.pool, g.session.tid, days));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
