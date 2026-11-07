/**
 * CarbonWMS Email — pure rules (no database, no network), tested by
 * scripts/test-email-rules.ts.
 *
 *  - which addresses we never write to (fake, staff, test, typos);
 *  - the per-person code format;
 *  - the merge tags a design's HTML may use, and filling them in;
 *  - making AI-written HTML safe to send (no scripts, forms, iframes, event
 *    handlers, javascript: links) and adding the footer every marketing email
 *    must carry (CAN-SPAM: unsubscribe link + postal address), which the AI
 *    never gets to leave out.
 */
import { randomInt } from "node:crypto";

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/;
const FAKE_RE = /(@example\.|@test\.|^test[^@]*@|@(mailinator|yopmail|guerrillamail)\.|^(none|no|na|noemail|nomail|x+|asdf|abc123?)@)/;
const STAFF_RE = /@(shopcarbon|carbonjeanscompany|carbonjeans)\.com$/;
const TYPO_RE = /@(gmial|gmal|gamil|gmai|gnail|hotmial|hotmal|yaho|yahooo)\.|\.(con|cm|comm)$/;

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return EMAIL_RE.test(e) && e.length <= 254 ? e : null;
}

/** Why an address is never mailed, or null when it is fine. */
export function exclusionReason(email: string): "fake" | "staff" | "typo" | null {
  if (FAKE_RE.test(email)) return "fake";
  if (STAFF_RE.test(email)) return "staff";
  if (TYPO_RE.test(email)) return "typo";
  return null;
}

/** Shopify asks for names cleaned of e-mail-ish junk; keep the first word, capitalised. */
export function cleanFirstName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const w = v.trim().split(/\s+/)[0] ?? "";
  if (!w || w.length > 30 || /[@\d<>{}]/.test(w)) return null;
  return w.charAt(0).toLocaleUpperCase("en-US") + w.slice(1).toLocaleLowerCase("en-US");
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
export function personalCode(prefix: string, pick: (n: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < 6; i++) s += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return `${prefix}-${s}`;
}

/** A code prefix the owner typed: 2–12 letters/digits, upper case. */
export function cleanPrefix(v: unknown, fallback = "CB"): string {
  const p = typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) : "";
  return p.length >= 2 ? p : fallback;
}

/* --------------------------------------------------------------- merge tags */

export const MERGE_TAGS = [
  "first_name",
  "greeting_name",
  "code",
  "code_url",
  "offer_amount",
  "offer_ends",
  "shop_url",
  "instagram_url",
  "unsubscribe_url",
] as const;
export type MergeTag = (typeof MERGE_TAGS)[number];
export type MergeValues = Partial<Record<MergeTag, string>>;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * Fill {{tag}} (spaces allowed). Unknown tags are left out. Values are
 * HTML-escaped; when a value is missing, a tag inside an <a href> keeps the
 * link working by falling back to the shop URL.
 */
export function fillMergeTags(html: string, v: MergeValues): string {
  return html.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_m, tag: string) => {
    if (!(MERGE_TAGS as readonly string[]).includes(tag)) return "";
    const val = v[tag as MergeTag];
    if (val != null) return esc(val);
    if (tag === "greeting_name") return "there";
    if (tag === "code_url" || tag === "shop_url") return esc(v.shop_url ?? "https://shopcarbon.com");
    return "";
  });
}

/** The merge tags a template uses (for the "this email expects a code" check). */
export function usedMergeTags(html: string): MergeTag[] {
  const out = new Set<MergeTag>();
  for (const m of html.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)) if ((MERGE_TAGS as readonly string[]).includes(m[1])) out.add(m[1] as MergeTag);
  return [...out];
}

/* ------------------------------------------------------------- safe HTML */

/**
 * AI-written email HTML, made safe: drops <script>, <iframe>, <object>,
 * <embed>, <form>, <input>, <button>, <link>, <meta http-equiv>, on* handlers,
 * and javascript:/data: links (data: images stay allowed only for <img>, but
 * the converter replaces them with hosted pictures anyway).
 */
export function sanitizeEmailHtml(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, (c) => (/\[if |endif\]/i.test(c) ? c : "")); // keep Outlook conditionals
  s = s.replace(/<(script|iframe|object|embed|form|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  s = s.replace(/<(script|iframe|object|embed|form|input|button|textarea|select|link|base)\b[^>]*\/?>/gi, "");
  s = s.replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "");
  s = s.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  s = s.replace(/(href|src|action|background)\s*=\s*(["'])\s*(javascript|vbscript):[^"']*\2/gi, '$1="#"');
  s = s.replace(/href\s*=\s*(["'])\s*data:[^"']*\1/gi, 'href="#"');
  s = s.replace(/expression\s*\(/gi, "");
  return s;
}

/** The body part of a full HTML document (or the input when it has no <body>). */
export function bodyOf(html: string): string {
  const m = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return m ? m[1] : html;
}

/** <style> blocks from the <head> (kept: Gmail, Apple Mail and Outlook.com honour them). */
export function headStyles(html: string): string {
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? "";
  return [...head.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]).join("\n");
}

export const FOOTER_MARK = "<!--carbon-footer-->";

/**
 * The finished email: the design's body inside a standard shell, a hidden
 * preheader, and Carbon's own footer (unsubscribe + postal address + why).
 * Merge tags are NOT filled here (that is per person).
 */
export function wrapEmail(input: { designHtml: string; subject: string; preheader: string; postalAddress: string }): string {
  const safe = sanitizeEmailHtml(input.designHtml);
  const body = bodyOf(safe).replace(FOOTER_MARK, "");
  const styles = headStyles(safe);
  const pre = input.preheader.trim();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${esc(input.subject)}</title>
${styles}
</head>
<body style="margin:0;padding:0;background:#ffffff;">
${pre ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(pre)}${"&#8199;&#65279;&#847; ".repeat(40)}</div>` : ""}
${body}
${FOOTER_MARK}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;"><tr><td align="center" style="padding:8px 16px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:Helvetica,Arial,sans-serif;">
<tr><td style="border-top:1px solid #e5e5e5;padding-top:16px;font-size:12px;line-height:1.6;color:#888888;text-align:center;">
You're getting this because you've shopped with Carbon. <a href="{{unsubscribe_url}}" style="color:#888888;text-decoration:underline;">Unsubscribe</a><br>${esc(input.postalAddress)}
</td></tr></table>
</td></tr></table>
</body></html>`;
}

/** A plain-text version (mail apps and spam filters like having one). */
export function htmlToText(html: string): string {
  return bodyOf(html)
    .replace(/<(style|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, "")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return t && !/^https?:/.test(t) ? `${t} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|table)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#8199;|&#65279;|&#847;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------- safety */

/** Auto-pause: after `min` finished sends, pause when bounces+complaints pass the limit. */
export function shouldPause(input: { sent: number; bounced: number; complained: number; pausePct: number; min?: number }): string | null {
  const min = input.min ?? 150;
  if (input.sent < min) return null;
  const bouncePct = (input.bounced / input.sent) * 100;
  if (bouncePct >= input.pausePct) return `${bouncePct.toFixed(1)}% of emails bounced (limit ${input.pausePct}%)`;
  const complaintPct = (input.complained / input.sent) * 100;
  if (complaintPct >= 0.1) return `${complaintPct.toFixed(2)}% of people marked it as spam (limit 0.1%)`;
  return null;
}

/** "Sunday, November 29" in Eastern time. */
export function longDay(iso: string | Date): string {
  return new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric" });
}
