/**
 * GET /api/email/designs/<id>/preview — the converted email as a customer
 * will get it (sample name and code, real footer), for the preview frames.
 */
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { getEmailSettings } from "@/lib/server/email/config";
import { mergeValuesFor } from "@/lib/server/email/campaigns";
import { SAMPLE_CODE, SAMPLE_NAME } from "@/lib/server/email/designer";
import { fillMergeTags, wrapEmail } from "@/lib/server/email/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new Response("Not found", { status: 404 });
  const d = await g.pool.query<{ html: string | null; subject_hint: string | null; preheader_hint: string | null }>(
    `SELECT html, subject_hint, preheader_hint FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, g.session.tid],
  );
  const row = d.rows[0];
  if (!row?.html) return new Response("<p style='font:14px sans-serif;padding:20px'>Not converted yet.</p>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const s = await getEmailSettings(g.pool, g.session.tid);
  const html = wrapEmail({ designHtml: row.html, subject: row.subject_hint ?? "", preheader: row.preheader_hint ?? "", postalAddress: s.postalAddress });
  const ends = new Date(Date.now() + 21 * 86400_000).toISOString();
  const out = fillMergeTags(html, { ...mergeValuesFor({ firstName: SAMPLE_NAME, code: SAMPLE_CODE, offer: { amount: 20, endsAt: ends, minSubtotal: null, prefix: "CB20" }, unsubToken: "preview" }) });
  return new Response(out, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    },
  });
}
