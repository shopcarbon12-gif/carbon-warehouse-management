import { withActivity } from "@/lib/server/activity-log";
/**
 * The order panel's "Thank-you code" switch.
 *   GET → { enabled, blocked, code, endsAt, used, expired }
 *   PUT { enabled: boolean } → ON creates the order's 15%-off code now; OFF
 *       deletes THIS order's code (Shopify + Rewards page) and stops printing
 *       from creating one. Admin only, like the order itself.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionFromRequest } from "@/lib/get-session-from-request";
import { getPool } from "@/lib/db";
import { requireSessionScopes } from "@/lib/server/api-require-scopes";
import { SCOPES } from "@/lib/auth/roles";
import { getThankYouState, setThankYouEnabled } from "@/lib/server/packing-slip/thank-you-code";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function guard(req: Request, params: Ctx["params"]) {
  const session = await getSessionFromRequest(req);
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const pool = getPool();
  if (!pool) return { error: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  const denied = await requireSessionScopes(pool, session, [SCOPES.ADMIN]);
  if (denied) return { error: denied };
  const { id } = await params;
  if (!/^\d{1,20}$/.test(id)) return { error: NextResponse.json({ error: "Bad order id" }, { status: 400 }) };
  return { session, pool, id };
}

export async function GET(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("error" in g) return g.error;
  try {
    return NextResponse.json(await getThankYouState(g.pool, g.id), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not read the code" }, { status: 502 });
  }
}

const bodySchema = z.object({ enabled: z.boolean() });

async function PUT_handler(req: Request, { params }: Ctx) {
  const g = await guard(req, params);
  if ("error" in g) return g.error;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  try {
    const r = await setThankYouEnabled(g.pool, g.id, parsed.data.enabled, {
      tenantId: g.session.tid,
      userId: g.session.sub,
    });
    if (!r.ok) return NextResponse.json({ error: r.error, ...r.state }, { status: 409 });
    return NextResponse.json(r.state);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Could not change the code" }, { status: 502 });
  }
}

export const PUT = withActivity("shopify/sales/[id]/thank-you-code", PUT_handler);
