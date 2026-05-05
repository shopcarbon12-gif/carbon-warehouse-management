import { NextResponse } from "next/server";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import {
  classifyVariance,
  getSession,
  renderSessionCsv,
} from "@/lib/server/rfid-cycle-count-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });

  const { id } = await params;
  const client = await pool.connect();
  try {
    const detail = await getSession(client, session.tid, id);
    if (!detail) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const variance = await classifyVariance(
      client,
      session.tid,
      detail.expected,
      detail.scanned_epcs,
    );
    const body = renderSessionCsv(detail, variance);
    const safeName = (detail.name || `session-${id}`).replace(/[^A-Za-z0-9._-]/g, "_");
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="cycle-count_${safeName}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    client.release();
  }
}
