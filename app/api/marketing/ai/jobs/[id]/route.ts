import { withActivity } from "@/lib/server/activity-log";
/**
 * PATCH /api/marketing/ai/jobs/[id] { action: "dismiss" } — hide a finished AI
 * result from the post (after "Use it", or when it is not wanted).
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

async function PATCH_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (!/^[0-9a-f-]{36}$/i.test(id) || body?.action !== "dismiss") return NextResponse.json({ error: "Nothing to do" }, { status: 400 });
  const r = await g.pool.query(
    `UPDATE marketing_ai_jobs SET status = 'dismissed', updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid AND status IN ('done', 'failed')`,
    [id, g.session.tid],
  );
  return NextResponse.json({ ok: Boolean(r.rowCount) });
}

export const PATCH = withActivity("marketing/ai/jobs/[id]", PATCH_handler);
