import { withActivity } from "@/lib/server/activity-log";
import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { deleteCalibrationPoint } from "@/lib/server/antenna-calibration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function DELETE_handler(req: Request, { params }: Ctx) {
  const userSession = await getSessionFromRequest(req);
  if (!userSession) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "Bad id" }, { status: 400 });
  }
  const r = await deleteCalibrationPoint(pool, userSession.tid, id);
  if (!r.deleted) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withActivity("antenna-test/calibrate/[id]", DELETE_handler);
