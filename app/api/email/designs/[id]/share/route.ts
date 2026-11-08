import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/designs/<id>/share {messageId} — a phone link for one
 * version (owner, 2026-11-08: open it on the phone from WhatsApp). The link is
 * unguessable and read-only, shows sample name and code, and is the same
 * every time for that version.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { WMS_BASE } from "@/lib/server/email/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { messageId?: string };
  if (!UUID_RE.test(id) || !UUID_RE.test(String(body.messageId ?? ""))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const r = await g.pool.query<{ share_token: string }>(
    `UPDATE email_design_messages m SET share_token = COALESCE(m.share_token, $3)
       FROM email_designs d WHERE d.id = m.design_id AND m.id = $1::uuid AND m.design_id = $2::uuid AND d.tenant_id = $4::uuid AND m.html IS NOT NULL
     RETURNING m.share_token`,
    [body.messageId, id, randomBytes(18).toString("base64url"), g.session.tid],
  );
  if (!r.rows[0]) return NextResponse.json({ error: "This version has no email yet" }, { status: 404 });
  return NextResponse.json({ url: `${WMS_BASE}/api/public/email/view/${r.rows[0].share_token}` });
}

export const POST = withActivity("email/designs/[id]/share", POST_handler);
