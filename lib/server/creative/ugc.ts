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
    brandBlock(brand, v.preset, true),
    `CREATOR PERSONA: ${v.persona}.`,
    "HOW THE CREATOR TALKS (owner, 2026-11-15: \"she shouldn't talk like a walking advertisement — like a woman filming herself in front of the mirror, recommending it\"): exactly like a real person (a girl or a guy — match the creator) talking to their phone in their room — casual, warm, a little spontaneous, full sentences the way people actually speak (\"okay so…\", \"honestly\", \"look at this\", \"I love that…\", \"it's so soft\"). They react to the piece: how it feels, how it fits, how they'd wear it, what they like about one or two details. Then an easy, friendly recommendation (\"you guys need this, it's on shopcarbon.com\"). NEVER slogans, taglines or ad copy — no \"locked in\", \"details do the talking\", \"no extra\", \"elevate your look\", no brand-speak, no lists of features. It must not sound like a TV commercial.",
    `FACTS SHEET (the ONLY facts you may use): ${JSON.stringify(v.facts)}`,
    v.concept ? `CONCEPT: ${v.concept.idea ?? ""} · what the first second LOOKS like (a picture, not words to say): ${v.concept.hook?.first_1_5s ?? ""}` : "",
    "hook, every lines[].say and cta are ONLY the words the creator says out loud, in first person — never a description of what they do, never their name, never stage directions (those go in lines[].action). The cta is her one closing sentence; don't repeat the shop line twice.",
    "Structure: a natural opener (≤ 8 words, e.g. \"Okay, you guys have to see this dress\") → 2–4 things they say about how it feels / fits / one detail they love (each line names the fact it uses; feelings like 'I love it' are fine, invented facts are not) → a casual recommendation that mentions shopcarbon.com. About 30–45 spoken words in total, 12–18 seconds.",
    "FORBIDDEN: invented reviews, ratings, sales numbers, 'best seller', 'everyone is buying', claiming to be a customer ('I bought this'), any claim not in the facts, other brands, where it is made.",
    "banned_check: answer honestly whether your script breaks any rule (all should be false).",
  ]
    .filter(Boolean)
    .join("\n\n");
  for (let i = 0; i < 2; i++) {
    const s = (await json(pool, prompt + (i ? "\n\nYOUR LAST SCRIPT BROKE A RULE — rewrite without any review, stat or customer claim." : ""), UgcScript, { tenantId, what: "UGC script", projectId: v.projectId, maxOutputTokens: 2000 })).value;
    const all = [s.hook, ...s.lines.map((l) => l.say), s.cta].join(" ");
    // A spoken line that reads like a stage direction ("Elena pulls the hood up…") is rejected and rewritten.
    const name = (v.persona.match(/^[A-Z][a-z]+/)?.[0] ?? "").trim();
    if (i === 0 && /\b(she|her|pulls|steps|turns|the phone is|camera)\b/i.test(s.hook + " " + s.cta)) continue;
    if (i === 0 && name && new RegExp(`\\b${name}\\b`).test(all)) continue;
    if (!FAKE.test(all) && !s.banned_check.invented_reviews && !s.banned_check.invented_stats && !s.banned_check.claims_to_be_customer) return s;
  }
  throw new Error("The UGC script kept breaking the honesty rules (reviews / stats / customer claims). Try a different concept.");
}

/**
 * The Instagram post captions for a UGC, in the same natural voice as what the creator says (owner,
 * 2026-11-15: the captions were still the old slogans "Not dressed up. Locked in."). Facts only, no slogans.
 */
export async function writeUgcCaptions(pool: Pool, tenantId: string, v: { script: UgcScript; facts: Record<string, unknown>[]; projectId: string }): Promise<string[]> {
  const said = [v.script.hook, ...v.script.lines.map((l) => l.say), v.script.cta].join(" ");
  const r = await json(
    pool,
    [
      "Write 3 short Instagram captions for a CARBON creator video. The creator says in the video: " + JSON.stringify(said),
      `FACTS (the only claims allowed): ${JSON.stringify(v.facts)}`,
      "Sound like a real person posting their own video — casual, warm, 1–2 short sentences, maybe one emoji, end with shopcarbon.com. NO slogans or ad copy (no 'locked in', 'details do the talking', 'elevate'), no hashtags (they're added separately), no invented reviews or numbers, never say Carbon Jeans.",
    ].join("\n\n"),
    z.object({ captions: z.array(z.string().max(300)).min(1).max(3) }),
    { tenantId, what: "UGC post captions", projectId: v.projectId, maxOutputTokens: 1500 },
  );
  return r.value.captions;
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
