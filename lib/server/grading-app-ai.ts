import type { Pool } from "pg";
import type { GradingProfile } from "@/lib/size-grading/grading-app-profiles";

/**
 * CarbonGradingAI's AI switch (owner, 2026-10-22): on/off, and which areas the
 * AI places. Everything an area leaves out is measured from the outline and
 * can be fixed later on the saved photo. Each area's cost comes from the
 * calls logged in grading_app_ai_calls.
 */
export const AI_AREAS = ["sleeves", "crotch", "chest", "other"] as const;
export type AiArea = (typeof AI_AREAS)[number];

export const AI_AREA_LABEL: Record<AiArea, string> = {
  sleeves: "Sleeves & shoulders",
  crotch: "Crotch, rise, thigh & inseam",
  chest: "Chest & waist (sleeves-up photo)",
  other: "Everything else (length, hem, openings…)",
};

export type AiSettings = { enabled: boolean; areas: Record<AiArea, boolean> };

/** Before the switch existed: the seam points (sleeves, crotch) and the sleeves-up photo's chest. */
export const DEFAULT_AI: AiSettings = { enabled: true, areas: { sleeves: true, crotch: true, chest: true, other: false } };

const SLEEVES = new Set(["shoulder", "sleeve", "sleeveL", "sleeveR", "strap", "armhole"]);
const CROTCH = new Set(["rise", "thigh", "thighL", "thighR", "inseam", "inseamL", "inseamR"]);

/** The area a point belongs to: a top's waist is the sleeves-up photo's; a bottom's waist is its waistband. */
export function areaOf(profile: Pick<GradingProfile, "group">, key: string): AiArea {
  if (SLEEVES.has(key)) return "sleeves";
  if (CROTCH.has(key)) return "crotch";
  if (key === "chest" || (key === "waist" && profile.group !== "bottoms")) return "chest";
  return "other";
}

export function allowedKeys(profile: GradingProfile, s: AiSettings): string[] {
  if (!s.enabled) return [];
  return profile.points.filter((p) => s.areas[areaOf(profile, p.key)]).map((p) => p.key);
}

function normalize(raw: unknown): AiSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as { enabled?: unknown; areas?: Record<string, unknown> };
  const areas = { ...DEFAULT_AI.areas };
  for (const a of AI_AREAS) if (typeof o.areas?.[a] === "boolean") areas[a] = o.areas[a] as boolean;
  return { enabled: typeof o.enabled === "boolean" ? o.enabled : DEFAULT_AI.enabled, areas };
}

export async function getAiSettings(pool: Pool, tenantId: string | null | undefined): Promise<AiSettings> {
  if (!tenantId) return DEFAULT_AI;
  const r = await pool.query<{ ai: unknown }>(`SELECT ai FROM grading_app_settings WHERE tenant_id = $1::uuid`, [tenantId]).catch(() => null);
  return normalize(r?.rows[0]?.ai);
}

export async function saveAiSettings(pool: Pool, tenantId: string, s: AiSettings, userId: string | null): Promise<AiSettings> {
  const n = normalize(s);
  await pool.query(
    `INSERT INTO grading_app_settings (tenant_id, ai, updated_at, updated_by) VALUES ($1::uuid, $2::jsonb, now(), $3)
     ON CONFLICT (tenant_id) DO UPDATE SET ai = EXCLUDED.ai, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tenantId, JSON.stringify(n), userId],
  );
  return n;
}

export async function logAiCall(
  pool: Pool,
  c: { tenantId: string | null | undefined; model: string; profile: GradingProfile; keys: string[]; runs: number; costUsd: number | null; ms: number | null },
): Promise<void> {
  const areas = c.keys.map((k) => areaOf(c.profile, k));
  await pool.query(
    `INSERT INTO grading_app_ai_calls (tenant_id, model, profile, keys, areas, runs, cost_usd, ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [c.tenantId ?? null, c.model, c.profile.id, c.keys, areas, c.runs, c.costUsd, c.ms],
  ).catch((e) => console.error("[grading-app/ai] cost log failed", e instanceof Error ? e.message : e));
}

/**
 * The crotch keeps its own model: on the owner's Colin crotch photos
 * (2026-10-22) gpt-6.1-sol read the rise 23–27.5 cm (hand-checked 28.7) and
 * gave no answer on 2 of 6 runs, while gpt-6-astra read 28.6.
 * GRADING_APP_AI_MODEL_CROTCH="same" uses the main model.
 */
export function crotchModel(mainModel: string): string {
  const m = (process.env.GRADING_APP_AI_MODEL_CROTCH || "gpt-6-astra").trim();
  return !m || m === "same" ? mainModel : m;
}

/** The model a call runs on: the crotch model when it places any crotch point. */
export function modelForKeys(profile: Pick<GradingProfile, "group">, keys: string[], mainModel: string): string {
  return keys.some((k) => areaOf(profile, k) === "crotch") ? crotchModel(mainModel) : mainModel;
}

/**
 * Starting points per size before a model has logged calls of an area, from the
 * owner's 2026-10-22 photos: gpt-6.1-sol measured (sleeves: one run on photo 1;
 * chest, crotch: the two runs the sleeves-up / crotch photo takes); gpt-6-astra
 * about 5× that (its price is 5×).
 */
const ESTIMATE_USD: Record<string, Partial<Record<AiArea, number>>> = {
  "gpt-6.1-sol": { sleeves: 0.023, chest: 0.052, crotch: 0.024, other: 0.02 },
  "gpt-6-astra": { sleeves: 0.11, chest: 0.26, crotch: 0.12, other: 0.1 },
};

export type AreaCost = { usd: number | null; calls: number; estimate: boolean; model: string | null };

/**
 * Average cost of one size's AI work in each area, on the model that area runs
 * on, over the last 30 days. A call that placed points of several areas splits
 * its cost by how many points each area had.
 */
export async function areaCosts(pool: Pool, mainModel: string | null): Promise<Record<AiArea, AreaCost>> {
  const modelOf = (a: AiArea) => (mainModel ? (a === "crotch" ? crotchModel(mainModel) : mainModel) : null);
  const out = Object.fromEntries(AI_AREAS.map((a) => [a, { usd: null, calls: 0, estimate: false, model: modelOf(a) }])) as Record<AiArea, AreaCost>;
  const models = [...new Set(AI_AREAS.map(modelOf).filter((m): m is string => !!m))];
  if (models.length) {
    const r = await pool.query<{ model: string; area: AiArea; usd: string | null; calls: string }>(
      `SELECT c.model, x.area, avg(c.cost_usd * x.n / cardinality(c.areas)) AS usd, count(*) AS calls
         FROM grading_app_ai_calls c
         CROSS JOIN LATERAL (SELECT a AS area, count(*) AS n FROM unnest(c.areas) a GROUP BY a) x
        WHERE c.model = ANY($1::text[]) AND c.cost_usd IS NOT NULL AND c.created_at > now() - interval '30 days'
        GROUP BY c.model, x.area`,
      [models],
    ).catch(() => null);
    for (const row of r?.rows ?? []) {
      if (!(row.area in out) || out[row.area].model !== row.model) continue;
      out[row.area] = { ...out[row.area], usd: row.usd == null ? null : Number(row.usd), calls: Number(row.calls) };
    }
  }
  for (const a of AI_AREAS) {
    const m = out[a].model; const est = m ? ESTIMATE_USD[m]?.[a] : undefined;
    if (!out[a].calls && est != null) out[a] = { ...out[a], usd: est, estimate: true };
  }
  return out;
}
