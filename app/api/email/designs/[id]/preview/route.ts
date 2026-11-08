/**
 * GET /api/email/designs/<id>/preview — the converted email as a customer
 * will get it (sample name and code, real footer), for the preview frames.
 * ?message=<versionId> shows one AI Designer version (layout engine) instead.
 */
import { marketingAdminGuard } from "@/lib/server/marketing/guard";
import { getEmailSettings } from "@/lib/server/email/config";
import { PREVIEW_CSP, previewHtml, versionPreview } from "@/lib/server/email/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const UUID_RE = /^[0-9a-f-]{36}$/i;

const page = (html: string) =>
  new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": PREVIEW_CSP } });

export async function GET(req: Request, { params }: Ctx) {
  const g = await marketingAdminGuard(req);
  if ("error" in g) return g.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) return new Response("Not found", { status: 404 });
  const message = new URL(req.url).searchParams.get("message");
  if (message) {
    if (!UUID_RE.test(message)) return new Response("Not found", { status: 404 });
    const html = await versionPreview(g.pool, g.session.tid, { messageId: message });
    return page(html ?? "<p style='font:14px sans-serif;padding:20px'>This version is not ready yet.</p>");
  }
  const d = await g.pool.query<{ html: string | null; subject_hint: string | null; preheader_hint: string | null }>(
    `SELECT html, subject_hint, preheader_hint FROM email_designs WHERE id = $1::uuid AND tenant_id = $2::uuid`,
    [id, g.session.tid],
  );
  const row = d.rows[0];
  if (!row?.html) return page("<p style='font:14px sans-serif;padding:20px'>Not converted yet.</p>");
  const s = await getEmailSettings(g.pool, g.session.tid);
  return page(previewHtml({ html: row.html, subject: row.subject_hint ?? "", preheader: row.preheader_hint ?? "", postalAddress: s.postalAddress }));
}
