import { withActivity } from "@/lib/server/activity-log";
/**
 * GET    /api/email/editor/<id> — the email's data for the editor.
 * PUT    /api/email/editor/<id> — save (autosave): { doc, title?, subject?, preheader?, snapshot? }.
 * DELETE /api/email/editor/<id> — remove it from the list (archived; campaigns that used it keep their copy).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { getEditorEmail, saveEditorEmail } from "@/lib/server/email/editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const e = await getEditorEmail(g.pool, g.session.tid, id);
  if (!e) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ email: e });
}

const schema = z
  .object({
    doc: z.unknown(),
    title: z.string().trim().min(1).max(80).optional(),
    subject: z.string().max(200).optional(),
    preheader: z.string().max(250).optional(),
    snapshot: z.boolean().optional(),
  })
  .strict();

async function PUT_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  try {
    const r = await saveEditorEmail(g.pool, g.session.tid, id, { ...p.data, doc: p.data.doc as never }, g.session.email ?? null);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

async function DELETE_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const r = await g.pool.query(`UPDATE email_designs SET archived_at = now(), updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid AND editor_doc IS NOT NULL`, [id, g.session.tid]);
  if (!r.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PUT = withActivity("email/editor/[id]", PUT_handler);
export const DELETE = withActivity("email/editor/[id]", DELETE_handler);
