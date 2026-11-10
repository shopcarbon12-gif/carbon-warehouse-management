import { withActivity } from "@/lib/server/activity-log";
/** PUT /api/email/segments/<id> { name, rules } · DELETE /api/email/segments/<id> */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { deleteSegment, saveSegment } from "@/lib/server/email/segments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const ok = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

async function PUT_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!ok(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { name?: unknown; rules?: unknown } | null;
  try {
    return NextResponse.json({ id: await saveSegment(g.pool, g.session.tid, g.session.email ?? null, { id, name: body?.name, rules: body?.rules }) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

async function DELETE_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!ok(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await deleteSegment(g.pool, g.session.tid, id);
  return NextResponse.json({ ok: true });
}

export const PUT = withActivity("email/segments/[id]", PUT_handler);
export const DELETE = withActivity("email/segments/[id]", DELETE_handler);
