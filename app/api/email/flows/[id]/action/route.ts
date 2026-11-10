import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/flows/<id>/action
 *   { action: "status", status: "live" | "paused" | "draft" } — turn on (only what happens from now on counts), pause, back to draft
 *   { action: "test", stepId, to? }                           — send one of its emails as a test (sample cart and code)
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { sendFlowTest, setFlowStatus } from "@/lib/server/email/flows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("status"),
    status: z.enum(["live", "paused", "draft"]),
  }),
  z.object({
    action: z.literal("test"),
    stepId: z.string().min(1).max(40),
    to: z.string().trim().max(300).optional(),
  }),
]);

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  try {
    if (p.data.action === "status")
      return NextResponse.json({
        flow: await setFlowStatus(g.pool, g.session.tid, id, p.data.status),
      });
    const to = (p.data.to || g.session.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(to)) return NextResponse.json({ error: "Type an address for the test" }, { status: 400 });
    await sendFlowTest(g.pool, g.session.tid, {
      flowId: id,
      stepId: p.data.stepId,
      to,
    });
    return NextResponse.json({ ok: true, to });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export const POST = withActivity("email/flows/[id]/action", POST_handler);
