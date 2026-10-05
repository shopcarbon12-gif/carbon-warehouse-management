import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { cleanEpcs, scanIn } from "@/lib/server/scan-out";
import { getReturn, scanInAllowance } from "@/lib/server/shopify-return-desk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scan in returned pieces: POST { epcs, returnId, rssi?, reader? }. The return
 * is read back from Shopify so only its items, up to their quantities, can
 * come in (lib/server/scan-out.ts scanIn).
 */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { epcs?: string[]; returnId?: string; reader?: string; rssi?: Record<string, number> };
  const epcs = cleanEpcs(body.epcs);
  const returnId = String(body.returnId ?? "");
  if (!epcs.length || !/^\d{1,20}$/.test(returnId)) return NextResponse.json({ ok: false, error: "Tags and a return are required." }, { status: 400 });
  let detail;
  try {
    detail = await getReturn(pool, returnId);
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : "Could not load the return." }, { status: 502 });
  }
  const results = await scanIn(pool, { tenantId: session.tid, userId: session.sub, locationId: session.lid ?? null }, epcs, {
    orderId: detail.orderId,
    orderName: detail.orderName,
    returnId: detail.id,
    returnName: detail.name,
    reader: body.reader?.slice(0, 60) || null,
    rssi: body.rssi && typeof body.rssi === "object" ? body.rssi : undefined,
    allowed: scanInAllowance(detail),
  });
  return NextResponse.json({ ok: results.every((r) => r.ok), results });
}

export const POST = withActivity("rfid/scan-in", POST_handler);
