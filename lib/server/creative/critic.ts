/**
 * CarbonWMS Creative — the AI Critic (spec §9), always on. A vision model scores every still and
 * clip 1–10 on garment accuracy (vs the Product Twin), AI artifacts, motion realism, brand fit,
 * hook strength and originality (pHash + the text/logos it can read vs other brands). Anything
 * under 7 is regenerated automatically (max 2 retries, cost-capped). The owner only sees passes.
 */
import type { Pool } from "pg";
import { z } from "zod";
import { brandBlock, getBrand } from "./config";
import { json } from "./llm";
import { hamming, phash } from "./media";

/**
 * The owner's bar (2026-11-15): "less than 9.5, don't show it to me — don't even send it on". A picture passes only
 * with an overall of 9.5+ AND no single score under 9. CREATIVE_PASS_OVERALL / CREATIVE_PASS_EACH override.
 */
export const PASS_OVERALL = Number(process.env.CREATIVE_PASS_OVERALL || 9.5);
export const PASS = Number(process.env.CREATIVE_PASS_EACH || 9);
/** Up to 4 tries for a picture at this bar (3 redraws), then it's left out and shown as missing. */
export const MAX_RETRIES = 3;

const Report = z.object({
  garment_accuracy: z.number().min(1).max(10),
  ai_artifacts: z.number().min(1).max(10), // 10 = none
  motion_realism: z.number().min(1).max(10).nullable(),
  brand_fit: z.number().min(1).max(10),
  hook_strength: z.number().min(1).max(10).nullable(),
  originality: z.number().min(1).max(10),
  ugc_realism: z.number().min(1).max(10).nullable().optional(),
  same_person: z.number().min(1).max(10).nullable().optional(),
  text_and_logos_seen: z.array(z.string()).max(10),
  problems: z.array(z.string()).max(6),
  note: z.string().max(160),
});
export type CriticReport = z.infer<typeof Report> & { overall: number; pass: boolean; fails: string[]; foreignBrands: string[] };

export async function criticize(
  pool: Pool,
  tenantId: string,
  v: {
    frames: Buffer[]; // the still, or keyframes of a clip in order
    kind: "still" | "clip" | "render";
    garmentRefs: Buffer[]; // twin cut-outs + detail crops
    shot?: { garment_must_show?: string; subject_action?: string; idx?: number } | null;
    preset?: string | null;
    projectId?: string | null;
    inspirationHashes?: string[];
    isHook?: boolean;
    /** UGC: also scored on looking like a real person's phone video (owner, 2026-11-15). */
    ugc?: boolean;
    /** The frame shows the garment before it is put on (hanger / bag / hands). */
    notWornYet?: boolean;
    /** A photo of the cast member: the critic fails a picture where the face is a different person. */
    personRef?: Buffer | null;
  },
): Promise<CriticReport> {
  const brand = await getBrand(pool, tenantId);
  // Up to 12 frames of a clip / take (6 missed the ring coming off in a 29 s take), then the real product + person.
  const frames = v.frames.slice(0, 12);
  const imgs = [...frames, ...v.garmentRefs.slice(0, 6), ...(v.personRef ? [v.personRef] : [])];
  const prompt = [
    "You are the quality gate for CARBON's ads. Be strict — the owner must never see anything fake, off-brand or showing the garment wrong.",
    brandBlock(brand, v.preset, v.ugc),
    `The first ${frames.length} picture(s) are the ${v.kind === "still" ? "generated still" : "keyframes of the generated clip, in order"}. Then ${Math.min(6, v.garmentRefs.length)} of the REAL product (cut-outs and real product photos — every colourway and angle; check the toe, sole, stripes, logo and colour against them exactly).${v.personRef ? " The very last picture is the REAL person (the cast member)." : ""}`,
    v.shot ? `The shot should show: ${v.shot.subject_action ?? ""}. The garment must show: ${v.shot.garment_must_show ?? "the product clearly"}.` : "",
    "Score 1–10 (10 = perfect). Be honest and strict: 9–10 only for work that is flawless and ready to publish; anything with a visible flaw is 8 or lower.",
    "garment_accuracy — colour, wash, graphic / logo letter-for-letter, fit, length, details vs the real product. AUTOMATIC FAIL (3 or lower) if in ANY frame a ring, zip, button, buckle, strap, chain or print comes off the garment, floats in a hand, or changes count / shape / place.",
    v.notWornYet ? "In this shot the garment may be on a hanger, in a bag or in the person's hands (not worn) — judge the garment itself, not whether it is worn." : "",
    "ai_artifacts — hands, faces, extra limbs, warping, melting text, flicker (10 = none at all).",
    v.kind === "still" ? "motion_realism — null for a still." : "motion_realism — natural body and fabric motion across the keyframes.",
    v.ugc
      ? "brand_fit — the clothes and the person fit CARBON and the do/don't list. Do NOT mark it down for looking casual, phone-shot or non-cinematic — that is what this is meant to be."
      : "brand_fit — the look, light and mood match CARBON's preset and do/don't list.",
    v.personRef ? "same_person — is it clearly the SAME person as the last picture: face shape, eyes, nose, lips, skin tone, hair (10), or a different-looking person (1–4)? Strict." : "same_person — null.",
    v.ugc
      ? "ugc_realism — does it look like a REAL person filmed it on their phone in an everyday place (10), or like a professional photo shoot / campaign set / cinematic lighting / film grade (1–4)? Strict: polished editorial = fail."
      : "ugc_realism — null.",
    v.isHook ? "hook_strength — would the first 1.5 s stop the scroll?" : "hook_strength — null unless this is the opening shot.",
    "originality — no OTHER brand's logo, name, text, people or photos (10 = fully original). Everything that is on the real product references (its stripes, prints, graphics, its own logo or tag) IS the product — never count the product's own design against originality, even if it looks like a famous brand's style.",
    "text_and_logos_seen — every word / logo you can read. problems — short, concrete. note — one line for the owner.",
  ]
    .filter(Boolean)
    .join("\n");
  // The answer was cut off at 900 tokens (the model's thinking counts too) → "The AI reply was not JSON" failed a
  // whole paid video (owner, 2026-11-15). More room, one retry, and if it still can't answer, the picture / clip
  // goes to the owner marked "not checked" instead of failing the job.
  const ask = () => json(pool, prompt, Report, { tenantId, what: `critic (${v.kind})`, projectId: v.projectId, images: imgs.map((b) => ({ b64: b.toString("base64") })), maxOutputTokens: 3000 });
  let r: z.infer<typeof Report>;
  try {
    r = (await ask().catch(() => ask())).value;
  } catch (e) {
    if (e instanceof Error && /Paused|cap/i.test(e.message)) throw e;
    return {
      garment_accuracy: 7, ai_artifacts: 7, motion_realism: null, brand_fit: 7, hook_strength: null, originality: 7, ugc_realism: null, same_person: null,
      text_and_logos_seen: [], problems: [], note: "The quality check couldn't answer for this one — please look at it yourself.",
      // A picture the check couldn't judge is NOT shown (the 9.5 bar); a filmed clip is kept for the owner to judge.
      overall: 7, pass: v.kind !== "still", fails: v.kind === "still" ? ["not_checked"] : [], foreignBrands: [],
    };
  }

  // Originality, hard checks: other brands' names in the readable text, and near-identical pictures.
  const names = (
    await pool.query<{ name: string }>(`SELECT name FROM creative_ad_brands WHERE tenant_id = $1::uuid AND status IN ('active','pending')`, [tenantId])
  ).rows.map((x) => x.name.toLowerCase());
  const seen = r.text_and_logos_seen.join(" ").toLowerCase();
  const foreignBrands = names.filter((n) => n.length > 3 && n !== "carbon" && new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(seen));
  let originality = r.originality;
  if (foreignBrands.length) originality = Math.min(originality, 2);
  if (v.inspirationHashes?.length && v.frames[0]) {
    const h = await phash(v.frames[0]).catch(() => null);
    if (h && v.inspirationHashes.some((x) => hamming(h, x) <= 12)) originality = Math.min(originality, 2);
  }
  const scores: Record<string, number | null> = {
    garment_accuracy: r.garment_accuracy,
    ai_artifacts: r.ai_artifacts,
    motion_realism: v.kind === "still" ? null : r.motion_realism,
    brand_fit: r.brand_fit,
    // Only the opening shot is judged on the hook, and only clips on motion — a number the model sends anyway
    // must not fail a picture (owner's sneaker shot 5 failed on "hook_strength", 2026-11-15).
    hook_strength: v.isHook ? r.hook_strength : null,
    originality,
    ugc_realism: v.ugc ? r.ugc_realism ?? null : null,
    same_person: v.personRef ? r.same_person ?? null : null,
  };
  const fails = Object.entries(scores).filter(([, s]) => s != null && s < PASS).map(([k]) => k);
  const vals = Object.values(scores).filter((s): s is number => s != null);
  const overall = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  return { ...r, ugc_realism: v.ugc ? r.ugc_realism ?? null : null, originality, overall, pass: fails.length === 0 && overall >= PASS_OVERALL, fails, foreignBrands };
}

export function criticSummary(c: CriticReport | null | undefined): string {
  if (!c) return "—";
  return `${c.overall}/10${c.pass ? "" : ` · failed: ${c.fails.join(", ")}`} · ${c.note}`;
}

/** What to change in the prompt for a retry, from the critic's problems. */
export function retryHint(c: CriticReport): string {
  const parts = [];
  if (c.fails.includes("garment_accuracy")) parts.push("Match the product references EXACTLY (colour, wash, graphic letter-for-letter, fit).");
  if (c.fails.includes("ai_artifacts")) parts.push("Natural anatomy: correct hands and fingers, no warping, no extra limbs, no melted text.");
  if (c.fails.includes("originality")) parts.push("No logos or words except the garment's own CARBON print.");
  if (c.fails.includes("brand_fit")) parts.push(c.ugc_realism != null ? "Keep it real and casual, but the clothes and person must fit CARBON." : "Stronger CARBON look: darker, moodier, more contrast, no stock-photo smiles.");
  if (c.fails.includes("motion_realism")) parts.push("Slower, more natural body and fabric motion.");
  if (c.fails.includes("same_person")) parts.push("The face must be EXACTLY the person in the person references (and the continuity frame): same face shape, eyes, nose, lips, skin tone and hair.");
  if (c.fails.includes("ugc_realism")) parts.push("Make it look like a real person's phone video: everyday room or street, plain window or room light, casual pose, no studio light, no cinematic set or grade.");
  if (!c.pass && !c.fails.length) parts.push(`It scored ${c.overall}/10 — the bar is ${PASS_OVERALL}. Make every detail flawless: exact product, sharp natural face and hands, clean believable light.`);
  return [...parts, ...c.problems.map((p) => `Fix: ${p}`)].join(" ");
}
