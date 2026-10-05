import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { cleanEpcs, undoScanOut } from "@/lib/server/scan-out";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { epc, orderId?, orderName? } — put a scanned-out tag back to what it was (lib/server/scan-out.ts). */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { epc?: string; orderId?: string; orderName?: string; returnId?: string; returnName?: string };
  const [epc] = cleanEpcs([body.epc]);
  if (!epc) return NextResponse.json({ ok: false, error: "Invalid EPC." }, { status: 400 });
  const r = await undoScanOut(
    pool,
    { tenantId: session.tid, userId: session.sub, locationId: session.lid ?? null },
    epc,
    {
      orderId: body.orderId?.slice(0, 40) || null,
      orderName: body.orderName?.slice(0, 40) || null,
      returnId: body.returnId?.slice(0, 40) || null,
      returnName: body.returnName?.slice(0, 40) || null,
    },
  );
  return NextResponse.json(r, { status: r.ok ? 200 : 409 });
}

export const POST = withActivity("rfid/ship-scan-out/undo", POST_handler);
