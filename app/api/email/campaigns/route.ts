import { withActivity } from "@/lib/server/activity-log";
/**
 * GET  /api/email/campaigns — every campaign with its numbers.
 * POST /api/email/campaigns — a new draft campaign.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { campaignStats } from "@/lib/server/email/campaigns";
import { parseAudience, parseOffer } from "@/lib/server/email/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const r = await g.pool.query(
    `SELECT c.id, c.name, c.status, c.subject, c.send_at, c.started_at, c.finished_at, c.pause_reason, c.offer, c.created_at, c.design_id, d.title AS design_title
       FROM email_campaigns c LEFT JOIN email_designs d ON d.id = c.design_id
      WHERE c.tenant_id = $1::uuid ORDER BY c.created_at DESC LIMIT 100`,
    [g.session.tid],
  );
  const campaigns = await Promise.all(r.rows.map(async (c) => ({ ...c, stats: c.status === "draft" ? null : await campaignStats(g.pool, c.id) })));
  return NextResponse.json({ campaigns });
}

const schema = z
  .object({
    name: z.string().trim().min(1).max(120),
    designId: z.string().uuid().nullable().optional(),
    subject: z.string().max(200).optional(),
    preheader: z.string().max(250).optional(),
    audience: z.unknown().optional(),
    offer: z.unknown().optional(),
  })
  .strict();

async function POST_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "Invalid campaign" }, { status: 400 });
  const audience = parseAudience(p.data.audience ?? {});
  const offer = parseOffer(p.data.offer);
  if (!audience || offer === "invalid") return NextResponse.json({ error: "Invalid audience or offer" }, { status: 400 });
  let subject = p.data.subject ?? "";
  let preheader = p.data.preheader ?? "";
  if (p.data.designId) {
    const d = await g.pool.query<{ subject_hint: string | null; preheader_hint: string | null }>(
      `SELECT subject_hint, preheader_hint FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`,
      [p.data.designId, g.session.tid],
    );
    if (!d.rows[0]) return NextResponse.json({ error: "Design not found" }, { status: 404 });
    subject ||= d.rows[0].subject_hint ?? "";
    preheader ||= d.rows[0].preheader_hint ?? "";
  }
  const r = await g.pool.query<{ id: string }>(
    `INSERT INTO email_campaigns (tenant_id, name, design_id, subject, preheader, audience, offer, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [g.session.tid, p.data.name, p.data.designId ?? null, subject, preheader, JSON.stringify(audience), offer ? JSON.stringify(offer) : null, g.session.email ?? null],
  );
  return NextResponse.json({ id: r.rows[0].id });
}

export const POST = withActivity("email/campaigns", POST_handler);
