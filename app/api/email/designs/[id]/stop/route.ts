import { withActivity } from "@/lib/server/activity-log";
/** POST /api/email/designs/<id>/stop — stop the AI turn that is still waiting or drawing. */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { stopTurn } from "@/lib/server/email/designer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const d = await g.pool.query(`SELECT 1 FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, g.session.tid]).catch(() => null);
  if (!d?.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ stopped: await stopTurn(g.pool, id) });
}

export const POST = withActivity("email/designs/[id]/stop", POST_handler);
