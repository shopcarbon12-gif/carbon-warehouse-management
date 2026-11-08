import { withActivity } from "@/lib/server/activity-log";
/**
 * GET /api/email/settings — sender settings + Amazon SES status (domain,
 *     DNS records to add, sandbox / production, quotas, event tracking).
 * PUT /api/email/settings — change the sender, reply-to, postal address,
 *     the sending switch, emails per minute and the auto-pause bounce limit.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { getEmailSettings, sesStatus } from "@/lib/server/email/config";
import { STORE, mediaStatus } from "@/lib/server/email/brand";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const [settings, ses, media] = await Promise.all([getEmailSettings(g.pool, g.session.tid), sesStatus(g.pool, g.session.tid), mediaStatus(g.pool).catch(() => null)]);
  return NextResponse.json({ settings, ses, media, store: STORE });
}

const schema = z
  .object({
    fromName: z.string().trim().min(1).max(60).optional(),
    fromEmail: z.string().trim().toLowerCase().email().max(120).optional(),
    replyTo: z.union([z.string().trim().toLowerCase().email().max(120), z.literal("")]).optional(),
    postalAddress: z.string().trim().min(10).max(200).optional(),
    sendingEnabled: z.boolean().optional(),
    maxPerMinute: z.number().int().min(1).max(3000).optional(),
    bouncePausePct: z.number().min(0.5).max(4.5).optional(),
  })
  .strict();

async function PUT_handler(req: Request) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const p = schema.safeParse(await req.json().catch(() => ({})));
  if (!p.success) return NextResponse.json({ error: p.error.issues[0]?.message ?? "Invalid settings" }, { status: 400 });
  const b = p.data;
  await getEmailSettings(g.pool, g.session.tid);
  await g.pool.query(
    `UPDATE email_settings SET
       from_name = COALESCE($2, from_name), from_email = COALESCE($3, from_email), reply_to = COALESCE($4, reply_to),
       postal_address = COALESCE($5, postal_address), sending_enabled = COALESCE($6, sending_enabled),
       max_per_minute = COALESCE($7, max_per_minute), bounce_pause_pct = COALESCE($8, bounce_pause_pct),
       updated_at = now(), updated_by = $9
     WHERE tenant_id = $1::uuid`,
    [g.session.tid, b.fromName ?? null, b.fromEmail ?? null, b.replyTo ?? null, b.postalAddress ?? null, b.sendingEnabled ?? null, b.maxPerMinute ?? null, b.bouncePausePct ?? null, g.session.email ?? null],
  );
  return NextResponse.json({ settings: await getEmailSettings(g.pool, g.session.tid) });
}

export const PUT = withActivity("email/settings", PUT_handler);
