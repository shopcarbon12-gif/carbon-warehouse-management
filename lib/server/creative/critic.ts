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

export const PASS = 7;
export const MAX_RETRIES = 2;

const Report = z.object({
  garment_accuracy: z.number().min(1).max(10),
  ai_artifacts: z.number().min(1).max(10), // 10 = none
  motion_realism: z.number().min(1).max(10).nullable(),
  brand_fit: z.number().min(1).max(10),
  hook_strength: z.number().min(1).max(10).nullable(),
  originality: z.number().min(1).max(10),
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
  },
): Promise<CriticReport> {
  const brand = await getBrand(pool, tenantId);
  const imgs = [...v.frames.slice(0, 6), ...v.garmentRefs.slice(0, 5)];
  const prompt = [
    "You are the quality gate for CARBON's ads. Be strict — the owner must never see anything fake, off-brand or showing the garment wrong.",
    brandBlock(brand, v.preset),
    `The first ${Math.min(6, v.frames.length)} picture(s) are the ${v.kind === "still" ? "generated still" : "keyframes of the generated clip, in order"}. The last ${Math.min(5, v.garmentRefs.length)} are the REAL product (cut-outs and detail crops).`,
    v.shot ? `The shot should show: ${v.shot.subject_action ?? ""}. The garment must show: ${v.shot.garment_must_show ?? "the product clearly"}.` : "",
    "Score 1–10 (10 = perfect):",
    "garment_accuracy — colour, wash, graphic / logo letter-for-letter, fit, length, details vs the real product.",
    "ai_artifacts — hands, faces, extra limbs, warping, melting text, flicker (10 = none at all).",
    v.kind === "still" ? "motion_realism — null for a still." : "motion_realism — natural body and fabric motion across the keyframes.",
    "brand_fit — the look, light and mood match CARBON's preset and do/don't list.",
    v.isHook ? "hook_strength — would the first 1.5 s stop the scroll?" : "hook_strength — null unless this is the opening shot.",
    "originality — no other brand's logo, name, text, people or photos (10 = fully original).",
    "text_and_logos_seen — every word / logo you can read. problems — short, concrete. note — one line for the owner.",
  ]
    .filter(Boolean)
    .join("\n");
  const r = (await json(pool, prompt, Report, { tenantId, what: `critic (${v.kind})`, projectId: v.projectId, images: imgs.map((b) => ({ b64: b.toString("base64") })), maxOutputTokens: 900 })).value;

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
    motion_realism: r.motion_realism,
    brand_fit: r.brand_fit,
    hook_strength: r.hook_strength,
    originality,
  };
  const fails = Object.entries(scores).filter(([, s]) => s != null && s < PASS).map(([k]) => k);
  const vals = Object.values(scores).filter((s): s is number => s != null);
  const overall = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
  return { ...r, originality, overall, pass: fails.length === 0, fails, foreignBrands };
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
  if (c.fails.includes("brand_fit")) parts.push("Stronger CARBON look: darker, moodier, more contrast, no stock-photo smiles.");
  if (c.fails.includes("motion_realism")) parts.push("Slower, more natural body and fabric motion.");
  return [...parts, ...c.problems.map((p) => `Fix: ${p}`)].join(" ");
}
