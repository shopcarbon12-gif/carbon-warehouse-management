import { withActivity } from "@/lib/server/activity-log";
/**
 * GET   /api/email/campaigns/<id> — the campaign, its numbers, what still
 *       blocks approval, how many people the audience reaches, and the
 *       latest problems (failed sends).
 * PATCH /api/email/campaigns/<id> — change a DRAFT (name, design, subject,
 *       preheader, audience, offer).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { approvalProblems, campaignStats, getCampaign } from "@/lib/server/email/campaigns";
import { audienceCount } from "@/lib/server/email/contacts";
import { getEmailSettings } from "@/lib/server/email/config";
import { parseAudience, parseOffer } from "@/lib/server/email/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const c = await getCampaign(g.pool, g.session.tid, id);
  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { html: _html, ...rest } = c;
  void _html;
  const s = await getEmailSettings(g.pool, g.session.tid);
  const draft = c.status === "draft";
  const [stats, problems, reach, failures] = await Promise.all([
    campaignStats(g.pool, id),
    draft ? approvalProblems(g.pool, g.session.tid, c, s) : Promise.resolve([]),
    draft ? audienceCount(g.pool, g.session.tid, c.audience) : Promise.resolve(null),
    g.pool.query(`SELECT email, error, status FROM email_campaign_recipients WHERE campaign_id = $1::uuid AND status IN ('failed') ORDER BY id DESC LIMIT 20`, [id]),
  ]);
  return NextResponse.json({ campaign: rest, stats, problems, reach, failures: failures.rows });
}

const schema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    designId: z.string().uuid().nullable().optional(),
    subject: z.string().max(200).optional(),
    preheader: z.string().max(250).optional(),
    audience: z.unknown().optional(),
    offer: z.unknown().optional(),
  })
  .strict();

async function PATCH_handler(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success || !UUID_RE.test(id)) return NextResponse.json({ error: p.success ? "Not found" : p.error.issues[0]?.message }, { status: 400 });
  const c = await getCampaign(g.pool, g.session.tid, id);
  if (!c) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (c.status !== "draft") return NextResponse.json({ error: "Only a draft can be changed. Send it back to draft first." }, { status: 409 });
  const b = p.data;
  const audience = b.audience === undefined ? c.audience : parseAudience(b.audience);
  const offer = b.offer === undefined ? c.offer : parseOffer(b.offer);
  if (!audience || offer === "invalid") return NextResponse.json({ error: "Invalid audience or offer" }, { status: 400 });
  await g.pool.query(
    `UPDATE email_campaigns SET name = $3, design_id = $4, subject = $5, preheader = $6, audience = $7, offer = $8, updated_at = now()
      WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, g.session.tid, b.name ?? c.name, b.designId === undefined ? c.design_id : b.designId, b.subject ?? c.subject, b.preheader ?? c.preheader, JSON.stringify(audience), offer ? JSON.stringify(offer) : null],
  );
  return NextResponse.json({ ok: true });
}

export const PATCH = withActivity("email/campaigns/[id]", PATCH_handler);
