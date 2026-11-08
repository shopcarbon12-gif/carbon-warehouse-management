import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/designs/<id>/approve {messageId, productIds, mediaIds} — the
 * owner approves the items the AI chose (after removing / swapping / adding
 * some); only then the pictures are drawn. Changed items: the AI rewrites its
 * briefs around exactly these items first.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { approveItems } from "@/lib/server/email/designer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

const body = z
  .object({
    messageId: z.string().regex(UUID_RE),
    productIds: z.array(z.string().max(80)).max(40),
    mediaIds: z.array(z.string().max(80)).max(10),
  })
  .strict();

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const p = body.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "Invalid items" }, { status: 400 });
  const d = await g.pool.query(`SELECT 1 FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, g.session.tid]);
  if (!d.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    await approveItems(g.pool, id, p.data.messageId, p.data.productIds, p.data.mediaIds);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}

export const POST = withActivity("email/designs/[id]/approve", POST_handler);
