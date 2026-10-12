import { withActivity } from "@/lib/server/activity-log";
/**
 * Store Replenishment (handheld): tick / untick one sale line as found and
 * pulled to the showroom. PUT { picked: boolean }. Stock is not changed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { setLinePicked } from "@/lib/server/store-replenishment";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ lineId: string }> };

const bodySchema = z.object({ picked: z.boolean() });

async function PUT_handler(req: Request, { params }: Ctx) {
  const session = await getSessionFromRequest(req);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const pool = getPool();
  if (!pool) return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
  const { lineId } = await params;
  if (!/^\d{1,10}$/.test(lineId)) return NextResponse.json({ error: "Bad line id" }, { status: 400 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const who = await pool.query<{ name: string | null }>(
    `SELECT nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '') AS name FROM users WHERE id = $1::uuid`,
    [session.sub],
  );
  const r = await setLinePicked(pool, session.lid, Number(lineId), parsed.data.picked, {
    userId: session.sub,
    name: who.rows[0]?.name ?? session.email ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 });
  return NextResponse.json({ ok: true, picked: parsed.data.picked });
}

export const PUT = withActivity("mobile/store-replenishment/lines/[lineId]", PUT_handler);
