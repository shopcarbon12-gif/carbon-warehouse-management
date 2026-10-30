/**
 * GET /api/marketing/channels/google-business/search-terms?months=3 — what
 * people typed on Google Search and Maps before the store showed up (the
 * Business Profile's Performance → Searches), most searched first.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { googleSearchTerms } from "@/lib/server/marketing/google-business";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const months = Math.min(12, Math.max(1, Number(new URL(req.url).searchParams.get("months")) || 3));
  const c = await g.pool.query<{ account_id: string; secret: string | null }>(
    `SELECT account_id, secret FROM marketing_channels WHERE tenant_id = $1::uuid AND provider = 'google_business' AND status = 'connected' LIMIT 1`,
    [g.session.tid],
  );
  const ch = c.rows[0];
  if (!ch?.secret) return NextResponse.json({ error: "Google Business is not connected" }, { status: 409 });
  try {
    return NextResponse.json({ months, terms: await googleSearchTerms(ch.secret, ch.account_id, months) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Google did not answer" }, { status: 502 });
  }
}
