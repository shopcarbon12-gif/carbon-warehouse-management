import { withActivity } from "@/lib/server/activity-log";
/**
 * GET    /api/email/flows/<id> — the flow, its numbers per email and the latest people in it.
 * PUT    /api/email/flows/<id> — { name?, trigger?, steps?, settings? } (checked; a live flow keeps its trigger).
 * DELETE /api/email/flows/<id> — archive it (people inside leave; sent history stays).
 */
import { NextResponse } from "next/server";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { archiveFlow, flowPeople, flowStats, getFlow, saveFlow } from "@/lib/server/email/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const ok = (id: string) => /^[0-9a-f-]{36}$/i.test(id);

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const f = ok(id) ? await getFlow(g.pool, g.session.tid, id) : null;
  if (!f) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const stats = (await flowStats(g.pool, [id])).get(id);
  return NextResponse.json({
    flow: f,
    stats,
    people: await flowPeople(g.pool, id),
  });
}

async function PUT_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!ok(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    return NextResponse.json({
      flow: await saveFlow(g.pool, g.session.tid, id, body),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

async function DELETE_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!ok(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await archiveFlow(g.pool, g.session.tid, id);
  return NextResponse.json({ ok: true });
}

export const PUT = withActivity("email/flows/[id]", PUT_handler);
export const DELETE = withActivity("email/flows/[id]", DELETE_handler);
