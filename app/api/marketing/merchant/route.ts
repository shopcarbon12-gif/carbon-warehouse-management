/**
 * GET /api/marketing/merchant — Google Merchant Center: how many products,
 * and every problem Google reports on them (disapproved = not shown; the rest
 * only warn), read live from the Merchant API.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { googleConfigured, listGmcIssues, merchantId } from "@/lib/server/google-merchant";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  if (!googleConfigured()) return NextResponse.json({ error: "The Google login is not set on the server" }, { status: 503 });
  try {
    const r = await listGmcIssues();
    return NextResponse.json({ merchantId: merchantId(), ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Merchant Center could not be read" }, { status: 502 });
  }
}
