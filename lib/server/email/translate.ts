/**
 * CarbonWMS Email — Spanish and Portuguese versions of a converted email (owner,
 * 2026-11-08). The words are translated; everything else is kept exactly:
 * tags, inline styles, every link and picture, every merge tag ({{…}}), prices,
 * product and set names, the store address. Latin-American Spanish and
 * Brazilian Portuguese (the store's languages), in CARBON's voice: short,
 * confident, warm. A translation is only kept when it has the same links,
 * pictures and merge tags as the English email.
 */
import type { Pool } from "pg";
import { openai, textModel } from "./config";
import { sanitizeEmailHtml } from "./rules";

export type Lang = "es" | "pt";
const NAME: Record<Lang, string> = { es: "Latin-American Spanish (es-419, as spoken in Florida)", pt: "Brazilian Portuguese (pt-BR)" };

const RULES = (lang: Lang) => `You translate a CARBON marketing email (HTML) from English into ${NAME[lang]}. Return JSON {"html": "the complete translated HTML document"}.
Translate every word a reader sees: headings, paragraphs, labels, buttons, the alt text of pictures, the <title>. Keep EXACTLY as they are: every HTML tag, attribute and inline style; every href and src; every merge tag in double curly braces ({{greeting_name}}, {{code}}, {{code_url}}, {{offer_amount}}, {{offer_ends}} …) — never translate or remove them; prices and currency ("$132.00"); product names, set names and the brand CARBON; the store address, phone and email; the discount code box.
Voice: short, confident, warm fashion copy — natural for the language, not word-for-word. Keep text length close to the English so the layout still fits. "Set $132.00" on a set card becomes ${lang === "es" ? '"Conjunto $132.00"' : '"Conjunto $132.00"'}; "2-PIECE SET" becomes ${lang === "es" ? '"CONJUNTO DE 2 PIEZAS"' : '"CONJUNTO DE 2 PEÇAS"'}.`;

const tags = (h: string) => (h.match(/\{\{\s*[a-z_]+\s*\}\}/g) ?? []).map((x) => x.replace(/\s+/g, "")).sort().join(",");
const srcs = (h: string) => (h.match(/\b(?:src|href)\s*=\s*["'][^"']*["']/gi) ?? []).map((x) => x.replace(/\s+/g, "")).sort().join(",");

/** One language; null when the translation did not keep every link, picture and merge tag. */
export async function translateEmail(html: string, lang: Lang): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await openai().chat.completions.create({
      model: textModel(),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RULES(lang) },
        { role: "user", content: html },
      ],
    });
    const j = JSON.parse(c.choices[0]?.message?.content ?? "{}") as { html?: string };
    const out = j.html ? sanitizeEmailHtml(j.html) : "";
    if (out && tags(out) === tags(html) && srcs(out) === srcs(html)) return out;
  }
  return null;
}

/** Translate a design's current email into Spanish and Portuguese (both at once). */
export async function translateDesign(pool: Pool, designId: string, log: (m: string) => void = console.log): Promise<void> {
  const d = await pool.query<{ html: string | null }>(`SELECT html FROM email_designs WHERE id = $1::uuid`, [designId]);
  const html = d.rows[0]?.html;
  if (!html) return;
  await pool.query(`UPDATE email_designs SET translate_status = 'running', html_es = NULL, html_pt = NULL WHERE id = $1::uuid`, [designId]);
  const [es, pt] = await Promise.all([translateEmail(html, "es").catch(() => null), translateEmail(html, "pt").catch(() => null)]);
  // Only if the English email did not change meanwhile (the owner may have edited the code).
  await pool.query(`UPDATE email_designs SET html_es = $2, html_pt = $3, translate_status = $4 WHERE id = $1::uuid AND html = $5`, [designId, es, pt, es && pt ? "done" : "failed", html]);
  log(`[email-translate] ${designId}: es ${es ? "ok" : "failed"}, pt ${pt ? "ok" : "failed"}`);
}
