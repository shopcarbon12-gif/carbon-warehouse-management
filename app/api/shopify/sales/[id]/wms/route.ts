/** The WMS side of one Shopify order (lib/server/shopify-sale-wms.ts). Admin only. */
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { ShopifyNotConnected, getSale } from "@/lib/server/shopify-sales";
import { saleWms } from "@/lib/server/shopify-sale-wms";

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
    const sale = await getSale(id);
    if (!sale) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    return NextResponse.json(await saleWms(pool, id, sale.lines));
  } catch (e) {
    if (e instanceof ShopifyNotConnected) return NextResponse.json({ error: e.message }, { status: 503 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not load the WMS side of the order." }, { status: 502 });
  }
}
