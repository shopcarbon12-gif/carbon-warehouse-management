import { withActivity } from "@/lib/server/activity-log";
/** POST /api/email/designs/<id>/pick {messageId} — choose one of the 3 directions; the chat continues from it. */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { pickDirection } from "@/lib/server/email/designer";

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
  const d = await g.pool.query(`SELECT 1 FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, g.session.tid]);
  if (!d.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await pickDirection(g.pool, id, String(body.messageId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}

export const POST = withActivity("email/designs/[id]/pick", POST_handler);
