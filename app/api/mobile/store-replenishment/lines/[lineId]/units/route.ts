import { withActivity } from "@/lib/server/activity-log";
/**
 * Store Replenishment, per unit (handheld "Find any unit").
 *   GET    → the line's SKU, sold qty, units already pulled, and the LIVE units
 *            of that exact SKU here not yet pulled for any line (search set).
 *   POST   { epc, method? } → record one pulled unit (re-validated now).
 *   DELETE ?epc= → undo one pulled unit.
 * Stock is never changed. See lib/server/store-replenishment.ts.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { getEligibleUnits, pickUnit, unpickUnit } from "@/lib/server/store-replenishment";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ lineId: string }> };

async function guard(req: Request, params: Ctx["params"]) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const { lineId } = await params;
  if (!/^\d{1,10}$/.test(lineId)) return { error: NextResponse.json({ error: "Bad line id" }, { status: 400 }) };
  return { session, pool, lineId: Number(lineId) };
}

export async function GET(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("error" in g) return g.error;
  const r = await getEligibleUnits(g.pool, g.session.lid, g.lineId);
  if (!r) return NextResponse.json({ error: "Line not found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}

const bodySchema = z.object({ epc: z.string().min(1).max(64), method: z.string().max(40).optional() });

async function pickerName(pool: NonNullable<ReturnType<typeof getPool>>, userId: string, email: string | null) {
  const who = await pool.query<{ name: string | null }>(
    `SELECT nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '') AS name FROM users WHERE id = $1::uuid`,
    [userId],
  );
  return who.rows[0]?.name ?? email ?? null;
}

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("error" in g) return g.error;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const r = await pickUnit(g.pool, g.session.lid, g.lineId, parsed.data.epc, {
    userId: g.session.sub,
    name: await pickerName(g.pool, g.session.sub, g.session.email ?? null),
    method: parsed.data.method ?? null,
  });
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}

async function DELETE_handler(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("error" in g) return g.error;
  const epc = new URL(req.url).searchParams.get("epc") ?? "";
  if (!epc) return NextResponse.json({ error: "epc required" }, { status: 400 });
  const r = await unpickUnit(g.pool, g.session.lid, g.lineId, epc);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r);
}

export const POST = withActivity("mobile/store-replenishment/lines/[lineId]/units", POST_handler);
export const DELETE = withActivity("mobile/store-replenishment/lines/[lineId]/units", DELETE_handler);
