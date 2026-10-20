/**
 * Email Popup — the welcome email with the shopper's code, sent through
 * Resend from support@shopcarbon.com (the store's own sender; shopcarbon.com
 * is verified on Resend). Plain black-and-white, in the shopper's language,
 * with a one-click unsubscribe (List-Unsubscribe + RFC 8058) and the store's
 * postal address (CAN-SPAM).
 */
import { EMAIL_COPY, longDate, langOf, type WelcomeLang } from "./rules";

const FROM = "Carbon <support@shopcarbon.com>";
const STORE = "https://shopcarbon.com";
const WMS = "https://wms.shopcarbon.com";
const ADDRESS = "Carbon · 6250 Edgewater Drive, Suite 100 · Orlando, FL 32810";

export function unsubscribeUrl(token: string): string {
  return `${WMS}/api/storefront/welcome-unsubscribe?t=${encodeURIComponent(token)}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function buildWelcomeEmail(input: {
  code: string;
  percent: number;
  endsAt: string | Date;
  locale: string | null;
  unsubToken: string;
}): { subject: string; html: string; text: string; lang: WelcomeLang } {
  const lang = langOf(input.locale);
  const t = EMAIL_COPY[lang];
  const date = longDate(input.endsAt, lang);
  const shop = `${STORE}/discount/${encodeURIComponent(input.code)}?redirect=%2F`;
  const unsub = unsubscribeUrl(input.unsubToken);
  const subject = t.subject(input.percent);

  const html = `<!doctype html>
<html lang="${lang === "pt" ? "pt-BR" : lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;color:#111111;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(t.preheader(input.percent))}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;">
<tr><td align="center" style="padding:40px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;font-family:Helvetica,Arial,sans-serif;">
<tr><td style="font-size:20px;font-weight:700;letter-spacing:8px;padding-bottom:36px;">CARBON</td></tr>
<tr><td style="font-size:24px;line-height:1.3;font-weight:700;padding-bottom:12px;">${esc(t.hello)}</td></tr>
<tr><td style="font-size:16px;line-height:1.5;color:#333333;padding-bottom:20px;">${esc(t.intro(input.percent))}</td></tr>
<tr><td style="padding-bottom:24px;">
  <div style="border:2px dashed #111111;padding:18px 12px;text-align:center;font-family:'Courier New',Courier,monospace;font-size:24px;font-weight:700;letter-spacing:3px;">${esc(input.code)}</div>
</td></tr>
<tr><td style="padding-bottom:28px;">
  <a href="${esc(shop)}" style="display:block;background:#111111;color:#ffffff;text-decoration:none;text-align:center;font-size:15px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:16px 12px;">${esc(t.button)}</a>
</td></tr>
<tr><td style="font-size:14px;line-height:1.6;color:#333333;padding-bottom:8px;">${esc(t.valid(date))} ${esc(t.useEmail)}</td></tr>
<tr><td style="font-size:13px;line-height:1.6;color:#666666;padding-bottom:36px;">${esc(t.terms)}</td></tr>
<tr><td style="border-top:1px solid #e5e5e5;padding-top:18px;font-size:12px;line-height:1.6;color:#888888;">
  ${esc(t.why)} <a href="${esc(unsub)}" style="color:#888888;">${esc(t.unsubscribe)}</a><br>${esc(ADDRESS)}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const text = [
    "CARBON",
    "",
    t.hello,
    t.intro(input.percent),
    "",
    `    ${input.code}`,
    "",
    `${t.button}: ${shop}`,
    "",
    `${t.valid(date)} ${t.useEmail}`,
    t.terms,
    "",
    "--",
    `${t.why} ${t.unsubscribe}: ${unsub}`,
    ADDRESS,
  ].join("\n");

  return { subject, html, text, lang };
}

/** Send through Resend. Returns the Resend id, or throws with Resend's message. */
export async function sendWelcomeEmail(input: {
  to: string;
  code: string;
  percent: number;
  endsAt: string | Date;
  locale: string | null;
  unsubToken: string;
}): Promise<string> {
  const key = (process.env.RESEND_API_KEY || "").trim();
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const mail = buildWelcomeEmail(input);
  const unsub = unsubscribeUrl(input.unsubToken);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [input.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      headers: { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      tags: [{ name: "type", value: "welcome_popup" }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!r.ok || !j.id) throw new Error(j.message || j.name || `Resend HTTP ${r.status}`);
  return j.id;
}
