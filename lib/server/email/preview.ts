/** CarbonWMS Email — one design version as a customer would get it (sample name + code), for previews and phone links. */
import type { Pool } from "pg";
import { getEmailSettings } from "./config";
import { mergeValuesFor } from "./campaigns";
import { SAMPLE_CODE, SAMPLE_NAME } from "./designer";
import { fillMergeTags, wrapEmail } from "./rules";

export const PREVIEW_CSP = "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

export function previewHtml(input: { html: string; subject: string; preheader: string; postalAddress: string }): string {
  const html = wrapEmail({ designHtml: input.html, subject: input.subject, preheader: input.preheader, postalAddress: input.postalAddress });
  const ends = new Date(Date.now() + 21 * 86400_000).toISOString();
  return fillMergeTags(html, mergeValuesFor({ firstName: SAMPLE_NAME, code: SAMPLE_CODE, offer: { amount: 20, endsAt: ends, minSubtotal: null, prefix: "CB20" }, unsubToken: "preview" }));
}

/** A version (layout engine) of a design, ready to show; null when it has no email yet. */
export async function versionPreview(pool: Pool, tenantId: string, where: { messageId: string } | { shareToken: string }): Promise<string | null> {
  const r = await pool.query<{ html: string | null; subject_hint: string | null; preheader_hint: string | null; tenant_id: string }>(
    `SELECT m.html, d.subject_hint, d.preheader_hint, d.tenant_id::text FROM email_design_messages m JOIN email_designs d ON d.id = m.design_id
      WHERE ${"messageId" in where ? "m.id = $1::uuid" : "m.share_token = $1"} AND m.role = 'ai' AND m.status = 'done'`,
    ["messageId" in where ? where.messageId : where.shareToken],
  );
  const row = r.rows[0];
  if (!row?.html) return null;
  if (tenantId && row.tenant_id !== tenantId) return null;
  const s = await getEmailSettings(pool, row.tenant_id);
  return previewHtml({ html: row.html, subject: row.subject_hint ?? "", preheader: row.preheader_hint ?? "", postalAddress: s.postalAddress });
}
