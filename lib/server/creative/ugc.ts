/**
 * CarbonWMS Creative — AI UGC (spec §7.5). The LLM writes a creator-style script from the facts
 * sheet ONLY (hook ≤ 1.5 s, natural voice, fit / fabric beats, CTA). It must never invent reviews,
 * customer claims or stats. Rendered with an engine that speaks (Veo native dialogue), captions
 * burned in, tagged ai_generated. The UI reminds the owner that AI UGC can't be presented as a real
 * customer testimonial and that platform AI labels apply.
 */
import type { Pool } from "pg";
import { z } from "zod";
import { brandBlock, getBrand } from "./config";
import { json } from "./llm";

export const UgcScript = z.object({
  persona: z.string().max(80),
  hook: z.string().max(90),
  lines: z
    .array(z.object({ say: z.string().max(140), action: z.string().max(160), seconds: z.number().min(1).max(8), fact_used: z.string().max(140).nullable() }))
    .min(3)
    .max(6),
  cta: z.string().max(80),
  banned_check: z.object({ invented_reviews: z.boolean(), invented_stats: z.boolean(), claims_to_be_customer: z.boolean() }),
});
export type UgcScript = z.infer<typeof UgcScript>;

const FAKE = /\b(\d+(\.\d+)?\s?(stars?|★)|best[- ]seller|#1|number one|everyone (loves|is buying)|thousands of|customers? (say|love)|i (bought|ordered) (this|it)|my (customers|followers) (say|love)|rated|reviews?)\b/i;

export async function writeUgcScript(pool: Pool, tenantId: string, v: { facts: Record<string, unknown>[]; persona: string; preset: string; concept: { hook?: { first_1_5s?: string }; idea?: string } | null; projectId: string }): Promise<UgcScript> {
  const brand = await getBrand(pool, tenantId);
  const prompt = [
    "Write a creator-style (UGC) video script for CARBON. It is AI-generated content and will be labelled as such.",
    brandBlock(brand, v.preset),
    `CREATOR PERSONA: ${v.persona}. Natural, spoken, short sentences, how a real creator talks to their phone.`,
    `FACTS SHEET (the ONLY facts you may use): ${JSON.stringify(v.facts)}`,
    v.concept ? `CONCEPT: ${v.concept.idea ?? ""} · hook idea: ${v.concept.hook?.first_1_5s ?? ""}` : "",
    "Structure: hook (said in the first 1.5 s, ≤ 8 words) → 2–4 beats on the fit and the fabric / details (each line names the fact it uses) → CTA (shopcarbon.com).",
    "FORBIDDEN: invented reviews, ratings, sales numbers, 'best seller', 'everyone is buying', claiming to be a customer ('I bought this'), any claim not in the facts, other brands, where it is made.",
    "banned_check: answer honestly whether your script breaks any rule (all should be false).",
  ]
    .filter(Boolean)
    .join("\n\n");
  for (let i = 0; i < 2; i++) {
    const s = (await json(pool, prompt + (i ? "\n\nYOUR LAST SCRIPT BROKE A RULE — rewrite without any review, stat or customer claim." : ""), UgcScript, { tenantId, what: "UGC script", projectId: v.projectId, maxOutputTokens: 2000 })).value;
    const all = [s.hook, ...s.lines.map((l) => l.say), s.cta].join(" ");
    if (!FAKE.test(all) && !s.banned_check.invented_reviews && !s.banned_check.invented_stats && !s.banned_check.claims_to_be_customer) return s;
  }
  throw new Error("The UGC script kept breaking the honesty rules (reviews / stats / customer claims). Try a different concept.");
}

/** Captions (≈ 3–4 words per card) timed over the lines. */
export function captionCards(s: UgcScript, start = 0.2): { text: string; at: number; dur: number }[] {
  const out: { text: string; at: number; dur: number }[] = [];
  let t = start;
  const lines = [{ say: s.hook, seconds: 1.5 }, ...s.lines.map((l) => ({ say: l.say, seconds: l.seconds })), { say: s.cta, seconds: 2 }];
  for (const l of lines) {
    const words = l.say.split(/\s+/).filter(Boolean);
    const chunks: string[] = [];
    for (let i = 0; i < words.length; i += 4) chunks.push(words.slice(i, i + 4).join(" "));
    const each = l.seconds / Math.max(1, chunks.length);
    for (const c of chunks) {
      out.push({ text: c, at: Math.round(t * 100) / 100, dur: Math.round(each * 100) / 100 });
      t += each;
    }
  }
  return out;
}

export const UGC_NOTICE = "AI-generated creator video. Don't present it as a real customer testimonial, and turn on the platform's AI label when you post (Instagram: \"AI info\").";
