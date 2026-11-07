import { withActivity } from "@/lib/server/activity-log";
/**
 * POST /api/email/campaigns/<id>/action
 *   { action: "test", to }            — a test email (sample code, not a real one)
 *   { action: "approve", sendAt? }    — freeze the email + the list, send at sendAt (or now)
 *   { action: "pause" | "resume" | "cancel" | "unapprove" }
 *   { action: "refresh" }             — read code use + sales from Shopify now
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { approveCampaign, refreshResults, sendTest, setCampaignState } from "@/lib/server/email/campaigns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
type Ctx = { params: Promise<{ id: string }> };

const schema = z
  .object({
    action: z.enum(["test", "approve", "pause", "resume", "cancel", "unapprove", "refresh"]),
    to: z.string().trim().toLowerCase().email().optional(),
    sendAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

async function POST_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const b = p.data;
  try {
    if (b.action === "test") {
      const to = b.to ?? g.session.email;
      if (!to) return NextResponse.json({ error: "Type the address for the test" }, { status: 400 });
      return NextResponse.json({ ok: true, messageId: await sendTest(g.pool, g.session.tid, { campaignId: id, to }), to });
    }
    if (b.action === "approve") {
      const r = await approveCampaign(g.pool, g.session.tid, id, g.session.email ?? "admin", b.sendAt ?? null);
      return NextResponse.json({ ok: true, ...r });
    }
    if (b.action === "refresh") {
      const c = await g.pool.query(`SELECT 1 FROM email_campaigns WHERE id = $1::uuid AND tenant_id = $2::uuid`, [id, g.session.tid]);
      if (!c.rowCount) return NextResponse.json({ error: "Not found" }, { status: 404 });
      await refreshResults(g.pool, id);
      return NextResponse.json({ ok: true });
    }
    await setCampaignState(g.pool, g.session.tid, id, b.action);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}

export const POST = withActivity("email/campaigns/[id]/action", POST_handler);
