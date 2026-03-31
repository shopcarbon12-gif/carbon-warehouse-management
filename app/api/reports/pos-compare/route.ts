import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getPosCompareForLocation } from "@/lib/queries/pos-compare";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return denied;

  const url = new URL(req.url);
  const locationId = url.searchParams.get("locationId")?.trim() || session.lid;

  const ok = await pool.query(
    `SELECT 1 FROM locations WHERE id = $1::uuid AND tenant_id = $2::uuid LIMIT 1`,
    [locationId, session.tid],
  );
  if (!ok.rows[0]) {
    return NextResponse.json({ error: "Location not found" }, { status: 404 });
  }

  try {
    const data = await getPosCompareForLocation(pool, session.tid, locationId);
    return NextResponse.json(
      {
        ...data,
        meta: {
          expected_qty_source: "custom_skus.ls_on_hand_total",
          hint:
            "Expected counts come from the last catalog / sync that populated POS on-hand (Lightspeed → WMS only; does not write LS QOH). Use Pull from LS or Inventory → Sync to refresh. Column LS ID is custom_skus.ls_item_id after a live R-Series catalog sync — needed for Push to LS and transfer AddItems from EPCs. Inventory transfer receive/complete: Lightspeed Retail UI only.",
          endpoints: {
            pull: "/api/integrations/lightspeed/pull",
            catalog_sync: "/api/inventory/sync/trigger",
          },
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    console.error("[reports/pos-compare]", e);
    return NextResponse.json({ error: "Query failed" }, { status: 500 });
  }
}
