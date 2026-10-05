import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { logReader } from "@/lib/server/scan-out";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST { action: "start" | "stop", orderId?, orderName? } — the reader being started or stopped, for the log. */
async function POST_handler(req: Request) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; orderId?: string; orderName?: string; reader?: string };
  if (body.action !== "start" && body.action !== "stop") return NextResponse.json({ error: "Bad action" }, { status: 400 });
  await logReader(
    pool,
    { tenantId: session.tid, userId: session.sub, locationId: session.lid ?? null },
    body.action === "start" ? "reader_start" : "reader_stop",
    body.reader?.slice(0, 60) || "192.168.1.87",
    { orderId: body.orderId?.slice(0, 40) || null, orderName: body.orderName?.slice(0, 40) || null },
  );
  return NextResponse.json({ ok: true });
}

export const POST = withActivity("rfid/ship-scan-out/reader", POST_handler);
