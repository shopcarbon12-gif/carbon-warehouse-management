import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/designs/<id>/check {action: "check" | "override"} — run the
 * visual check of the converted email again (render, review, fix), or use the
 * email anyway although it did not pass (owner's call).
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { aiDesignerOff, AI_DESIGNER_OFF_MSG } from "@/lib/server/email/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  const action = body.action === "override" ? "override" : "check";
  if (action === "check" && aiDesignerOff()) return NextResponse.json({ error: AI_DESIGNER_OFF_MSG }, { status: 410 });
  const r = await g.pool.query(
    action === "override"
      ? `UPDATE email_designs SET check_override = true, updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid AND html IS NOT NULL`
      : `UPDATE email_designs SET check_status = 'queued', check_override = false, updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND html IS NOT NULL AND status <> 'converting' AND COALESCE(check_status, '') NOT IN ('running', 'queued')`,
    [id, g.session.tid],
  );
  if (!r.rowCount) return NextResponse.json({ error: action === "override" ? "This design has no email yet" : "Nothing to check now (no email yet, or a check is already running)" }, { status: 409 });
  return NextResponse.json({ ok: true });
}

export const POST = withActivity("email/designs/[id]/check", POST_handler);
