/**
 * GET /api/email/catalog?q=… — in-stock products (matching sets as one item)
 * for the AI Designer's review step: swap or add an item before drawing.
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { searchCatalog } from "@/lib/server/email/designer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 80);
  try {
    return NextResponse.json({ items: await searchCatalog(q) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
