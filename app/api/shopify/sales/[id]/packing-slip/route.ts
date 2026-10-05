/**
 * The CARBON packing slip for one Shopify order, as a printable page.
 * Opened in a new tab from the order panel's "Print a packing slip" button;
 * `?print=1` opens the print dialog as soon as the page (and its images) load.
 * Admin only, like the order itself.
 */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { ShopifyNotConnected } from "@/lib/server/shopify-sales";
import { getPackingSlipOrder, renderPackingSlipHtml } from "@/lib/server/packing-slip";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const { id } = await params;
  if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: "Bad order id" }, { status: 400 });
  try {
    const order = await getPackingSlipOrder(id);
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    const html = renderPackingSlipHtml(order, { autoPrint: new URL(req.url).searchParams.get("print") === "1" });
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof ShopifyNotConnected) return NextResponse.json({ error: e.message }, { status: 503 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load the order." }, { status: 502 });
  }
}
