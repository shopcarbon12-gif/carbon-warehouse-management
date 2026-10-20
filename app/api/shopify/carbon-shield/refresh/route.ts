import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/shopify/carbon-shield/refresh — rebuild Carbon Shield's IP data now
 * (DB-IP Lite country + network lists, Google / Bing / Apple crawler ranges,
 * Google Cloud ranges). The worker does this daily on its own; this is the
 * "Refresh now" button. Admin only. Takes ~10–30 s.
 */
import { NextResponse } from "next/server";
import { shieldAdminGuard } from "@/lib/server/shield/guard";
import { refreshIpDb } from "@/lib/server/shield/ipdb";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function POST_handler(req: Request) {
  const g = await shieldAdminGuard(req);
  if ("error" in g) return g.error;
  try {
    const r = await refreshIpDb(g.pool);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Refresh failed" }, { status: 502 });
  }
}

export const POST = withActivity("shopify/carbon-shield/refresh", POST_handler);
