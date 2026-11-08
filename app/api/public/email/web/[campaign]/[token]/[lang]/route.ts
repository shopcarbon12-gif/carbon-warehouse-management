/**
 * GET /api/public/email/web/<campaign>/<token>/<en|es|pt> — one person's email
 * as a web page in English, Spanish or Portuguese (owner, 2026-11-08: the bold
 * language bar on top of every email links here; mail apps cannot switch the
 * language inside an email). Public (proxy.ts): the token is the person's own
 * unguessable unsubscribe token, so the page shows only their own email, with
 * their name and their personal code.
 */
import { getPool } from "@/lib/db";
import { getEmailSettings } from "@/lib/server/email/config";
import { mergeValuesFor, type Offer } from "@/lib/server/email/campaigns";
import { PREVIEW_CSP } from "@/lib/server/email/preview";
import { fillMergeTags, wrapEmail, type EmailLang } from "@/lib/server/email/rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ campaign: string; token: string; lang: string }> };

const notFound = () => new Response("Not found", { status: 404 });

export async function GET(_req: Request, { params }: Ctx) {
  const { campaign, token, lang: l } = await params;
  const lang = (["en", "es", "pt"] as const).find((x) => x === l);
  if (!lang || !/^[0-9a-f-]{36}$/i.test(campaign) || !/^[A-Za-z0-9_-]{8,80}$/.test(token)) return notFound();
  const pool = getPool();
  if (!pool) return new Response("Unavailable", { status: 503 });
  const c = await pool.query<{ tenant_id: string; status: string; subject: string; preheader: string; offer: Offer | null; html: string | null; html_es: string | null; html_pt: string | null; design_id: string | null }>(
    `SELECT tenant_id::text, status, subject, preheader, offer, html, html_es, html_pt, design_id::text FROM email_campaigns WHERE id = $1::uuid`,
    [campaign],
  );
  const row = c.rows[0];
  if (!row) return notFound();
  const contact = await pool.query<{ id: string; first_name: string | null }>(`SELECT id::text, first_name FROM email_contacts WHERE tenant_id = $1::uuid AND unsub_token = $2`, [row.tenant_id, token]);
  const who = contact.rows[0];
  if (!who) return notFound();
  let page: string | null = lang === "en" ? row.html : lang === "es" ? row.html_es : row.html_pt;
  if (!page && row.design_id) {
    // Not approved yet (a test email): wrap the design's current version.
    const d = await pool.query<{ html: string | null; html_es: string | null; html_pt: string | null }>(`SELECT html, html_es, html_pt FROM email_designs WHERE id = $1::uuid`, [row.design_id]);
    const dd = d.rows[0];
    const body = lang === "en" ? dd?.html : lang === "es" ? dd?.html_es : dd?.html_pt;
    if (body) {
      const s = await getEmailSettings(pool, row.tenant_id);
      const languages: EmailLang[] = ["en", ...(dd?.html_es ? (["es"] as const) : []), ...(dd?.html_pt ? (["pt"] as const) : [])];
      page = wrapEmail({ designHtml: body, subject: row.subject, preheader: row.preheader, postalAddress: s.postalAddress, lang, languages });
    }
  }
  if (!page) return notFound();
  const r = await pool.query<{ code: string | null }>(`SELECT code FROM email_campaign_recipients WHERE campaign_id = $1::uuid AND contact_id = $2::bigint`, [campaign, who.id]);
  const code = r.rows[0]?.code ?? (row.status === "draft" && row.offer ? `${row.offer.prefix}-TEST00` : null);
  const html = fillMergeTags(page, mergeValuesFor({ firstName: who.first_name, code, offer: row.offer, unsubToken: token, campaignId: campaign, lang })).replace(/\b(Hola|Olá|Oi)\s+([,!])/g, "$1$2");
  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PREVIEW_CSP, "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" },
  });
}
