import { withActivity } from "@/lib/server/activity-log";
/** DELETE /api/shopify/carbon-shield/rules/[id] — remove a Carbon Shield rule. Admin only. */
import { NextResponse } from "next/server";
import { shieldAdminGuard } from "@/lib/server/shield/guard";
import { invalidateShieldConfig } from "@/lib/server/shield/check";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function DELETE_handler(req: Request, { params }: Ctx) {
  const g = await shieldAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!/^\d{1,18}$/.test(id)) return NextResponse.json({ error: "Bad rule id" }, { status: 400 });
  const r = await g.pool.query(`DELETE FROM shield_rules WHERE id = $1::bigint`, [id]);
  invalidateShieldConfig();
  if (!r.rowCount) return NextResponse.json({ error: "Rule not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withActivity("shopify/carbon-shield/rules/[id]", DELETE_handler);
