/**
 * CarbonWMS Creative — settings, the Brand Brain defaults, keys and the spend caps.
 *
 * Budget rule (owner, spec §8 + §12): nothing that costs money runs unless the owner taps a button.
 * Every paid call goes through `spendGate()` first (jobs pause at a cap) and `recordSpend()` after.
 */
import OpenAI from "openai";
import type { Pool } from "pg";
import { getOpenAiApiKey } from "@/lib/openaiConfig";

export const PROVIDERS = ["openai", "fal"] as const;
export type Provider = (typeof PROVIDERS)[number];

export type Caps = Record<Provider, { daily: number; monthly: number }>;
export const DEFAULT_CAPS: Caps = { openai: { daily: 10, monthly: 100 }, fal: { daily: 15, monthly: 150 } };

export type CreativeSettings = {
  caps: Caps;
  routing: Record<string, string[]>;
  sources: Record<string, { enabled: boolean; apifyFallback?: boolean }>;
  categoryOptions: { bags: boolean; hats: boolean; belts: boolean };
  retentionDays: number;
  metaCountries: string[];
  updatedAt: string | null;
  updatedBy: string | null;
};

export async function getCreativeSettings(pool: Pool, tenantId: string): Promise<CreativeSettings> {
  await pool.query(`INSERT INTO creative_settings (tenant_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, [tenantId]);
  const r = await pool.query(`SELECT * FROM creative_settings WHERE tenant_id = $1::uuid`, [tenantId]);
  const s = r.rows[0];
  return {
    caps: { ...DEFAULT_CAPS, ...(s.caps ?? {}) },
    routing: s.routing ?? {},
    sources: s.sources ?? {},
    categoryOptions: { bags: false, hats: false, belts: false, ...(s.category_options ?? {}) },
    retentionDays: s.retention_days,
    metaCountries: s.meta_countries ?? [],
    updatedAt: s.updated_at?.toISOString?.() ?? null,
    updatedBy: s.updated_by ?? null,
  };
}

/* ------------------------------------------------------------------ keys */

export function falKey(): string {
  return (process.env.FAL_KEY || process.env.FAL_API_KEY || "").trim();
}
export function keysStatus() {
  return {
    openai: Boolean(getOpenAiApiKey().trim()),
    fal: Boolean(falKey()),
    meta: Boolean((process.env.META_AD_LIBRARY_TOKEN || process.env.META_SYSTEM_USER_TOKEN || "").trim()),
    snap: Boolean((process.env.SNAP_ADS_GALLERY_TOKEN || "").trim()),
    apify: Boolean((process.env.APIFY_TOKEN || "").trim()),
  };
}

export function openai(): OpenAI {
  const apiKey = getOpenAiApiKey().trim();
  if (!apiKey) throw new PlainError("The OpenAI key is not set on the server (OPENAI_API_KEY).");
  return new OpenAI({ apiKey, timeout: 10 * 60_000 });
}
export const textModel = () => (process.env.CREATIVE_TEXT_MODEL || process.env.EMAIL_AI_MODEL || "gpt-5.5").trim();
export const imageModel = () => (process.env.CREATIVE_IMAGE_MODEL || process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-sunburst").trim();
export const ttsModel = () => (process.env.CREATIVE_TTS_MODEL || "gpt-4o-mini-tts").trim();

/** An error whose message is safe and meant for the owner (plain English). */
export class PlainError extends Error {
  plain = true;
}

/* ------------------------------------------------------------------ spend */

export type SpendSummary = Record<Provider, { today: number; month: number; daily: number; monthly: number }> & { total: { today: number; month: number } };

export async function spendSummary(pool: Pool, tenantId: string): Promise<SpendSummary> {
  const caps = (await getCreativeSettings(pool, tenantId)).caps;
  const r = await pool.query<{ provider: Provider; today: string; month: string }>(
    `SELECT provider,
            COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'), 0) AS today,
            COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'), 0) AS month
       FROM creative_spend WHERE tenant_id = $1::uuid AND created_at >= now() - interval '32 days'
      GROUP BY provider`,
    [tenantId],
  );
  const out = { total: { today: 0, month: 0 } } as SpendSummary;
  for (const p of PROVIDERS) {
    const row = r.rows.find((x) => x.provider === p);
    const today = Number(row?.today ?? 0);
    const month = Number(row?.month ?? 0);
    out[p] = { today, month, daily: caps[p].daily, monthly: caps[p].monthly };
    out.total.today += today;
    out.total.month += month;
  }
  return out;
}

/** Throws a PlainError when `cost` would take a provider over its daily or monthly cap. */
export async function spendGate(pool: Pool, tenantId: string, provider: Provider, cost: number): Promise<void> {
  const s = (await spendSummary(pool, tenantId))[provider];
  const name = provider === "fal" ? "fal.ai (video)" : "OpenAI";
  if (s.today + cost > s.daily + 1e-9)
    throw new PlainError(`Paused: ${name} would pass today's cap ($${s.today.toFixed(2)} spent of $${s.daily.toFixed(2)}; this step ≈ $${cost.toFixed(2)}). Raise the cap in Creative → Settings, or wait until tomorrow.`);
  if (s.month + cost > s.monthly + 1e-9)
    throw new PlainError(`Paused: ${name} would pass this month's cap ($${s.month.toFixed(2)} of $${s.monthly.toFixed(2)}; this step ≈ $${cost.toFixed(2)}). Raise the cap in Creative → Settings.`);
}

export async function recordSpend(
  pool: Pool,
  tenantId: string,
  v: { provider: Provider; what: string; cost: number; estimated?: boolean; projectId?: string | null; generationId?: string | null },
): Promise<void> {
  if (!(v.cost > 0)) return;
  await pool.query(
    `INSERT INTO creative_spend (tenant_id, provider, what, cost_usd, estimated, project_id, generation_id)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7::uuid)`,
    [tenantId, v.provider, v.what.slice(0, 200), v.cost, v.estimated ?? true, v.projectId ?? null, v.generationId ?? null],
  );
}

/* ------------------------------------------------------------------ Brand Brain */

export type Preset = {
  key: string;
  name: string;
  look: string; // prompt words for the look
  grade: { contrast: number; saturation: number; brightness: number; warmth: number; grain: number };
  pacing: "fast" | "medium" | "slow";
  samples: string[]; // storage paths of sample frames
};

export const DEFAULT_PRESETS: Preset[] = [
  {
    key: "street",
    name: "CARBON Street",
    look: "moody industrial, higher contrast, slightly desaturated, urban and gritty, dark backgrounds, concrete and steel",
    grade: { contrast: 1.18, saturation: 0.82, brightness: -0.03, warmth: 0, grain: 0.12 },
    pacing: "fast",
    samples: [],
  },
  {
    key: "luxury",
    name: "CARBON Luxury",
    look: "deep blacks, soft directional light, editorial negative space, quiet and expensive, slow pacing",
    grade: { contrast: 1.1, saturation: 0.9, brightness: -0.05, warmth: 0.02, grain: 0.05 },
    pacing: "slow",
    samples: [],
  },
  {
    key: "evening",
    name: "CARBON Evening",
    look: "night, warm practical lights, satin and sheen, glam but moody, city lights bokeh",
    grade: { contrast: 1.12, saturation: 1.0, brightness: -0.04, warmth: 0.08, grain: 0.08 },
    pacing: "medium",
    samples: [],
  },
  {
    key: "florida",
    name: "CARBON Florida Day",
    look: "Orlando sun, palms, parking lots, skate parks, gas stations, harsh daylight turning to the first rain",
    grade: { contrast: 1.08, saturation: 1.05, brightness: 0.02, warmth: 0.06, grain: 0.1 },
    pacing: "fast",
    samples: [],
  },
];

// "the denim wash" only on denim pieces: the old "always show the denim wash up close" made every concept open
// on an invented denim shot for a black hooded dress, which the critic then rejected 3 times (owner, 2026-11-14).
export const DEFAULT_DOS = ["always show the real fabric up close (the wash on denim pieces only)", "show the real garment details: stitching, hardware, prints"];
export const DEFAULT_DONTS = ["no cheesy stock-photo smiles", "no cartoon fonts", "no other brands' logos or text", "no invented reviews, stats or claims"];

/**
 * The owner's edit taste, read from the three finished Reels (2026-11-03, ~/CarbonFinalReels:
 * 5 Days 5 Fits Elena + Nico, Jaylen Magic Swap): Kling clips of ~3 s, house music (deep / tech /
 * dark afro house), no day labels, film grain finish, CARBON end screen in Neuzeit Grotesk.
 * Defaults for every edit plan until the owner changes them.
 */
export const DEFAULT_EDIT_STYLE = {
  bpm: { min: 118, max: 126 },
  cutEveryBeats: 4,
  clipSeconds: 3,
  transitions: ["hard_cut", "match_cut", "flash_frame", "whip_pan"],
  musicMoods: ["deep house", "tech house", "dark afro house"],
  captionStyle: "bold condensed, white, bottom third inside Reels safe zone",
  endCard: { font: "Neuzeit Grotesk", text: "CARBON", sub: "shopcarbon.com", seconds: 1.6 },
  grain: 0.12,
  export: { width: 1080, height: 1920, fps: 30, lufs: -14 },
  source: "3 finished Reels in ~/CarbonFinalReels (2026-11-03)",
};

export type BrandBrain = {
  logos: Record<string, string>;
  fonts: { headline: string; body: string; headlineFile?: string | null; bodyFile?: string | null };
  colors: Record<string, string>;
  presets: Preset[];
  defaultPreset: string;
  voice: { description: string; samples: { text: string; verdict: "up" | "down" | null }[] };
  dos: string[];
  donts: string[];
  editStyle: typeof DEFAULT_EDIT_STYLE;
  platform: { default: string; tiktok: boolean };
  wizardDone: boolean;
  learned: Record<string, unknown>;
};

export async function getBrand(pool: Pool, tenantId: string): Promise<BrandBrain> {
  await pool.query(`INSERT INTO creative_brand (tenant_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, [tenantId]);
  const r = await pool.query(`SELECT * FROM creative_brand WHERE tenant_id = $1::uuid`, [tenantId]);
  const b = r.rows[0];
  const presets: Preset[] = Array.isArray(b.presets) && b.presets.length ? b.presets : DEFAULT_PRESETS;
  return {
    logos: { white: "/email/carbon-logo-long-white.png", black: "/email/carbon-logo-long-black.png", ...(b.logos ?? {}) },
    fonts: { headline: "Neuzeit Grotesk", body: "Inter", ...(b.fonts ?? {}) },
    colors: { ink: "#0a0a0a", paper: "#f4f2ee", accent: "#c8102e", muted: "#8a8a8a", ...(b.colors ?? {}) },
    presets,
    defaultPreset: b.default_preset || "street",
    voice: {
      description: "short, confident, street",
      samples: [],
      ...(b.voice ?? {}),
    },
    dos: b.dos?.length ? b.dos : DEFAULT_DOS,
    donts: b.donts?.length ? b.donts : DEFAULT_DONTS,
    editStyle: { ...DEFAULT_EDIT_STYLE, ...(b.edit_style ?? {}) },
    platform: { default: "instagram", tiktok: false, ...(b.platform ?? {}) },
    wizardDone: Boolean(b.wizard_done),
    learned: b.learned ?? {},
  };
}

export function presetOf(brand: BrandBrain, key: string | null | undefined): Preset {
  return brand.presets.find((p) => p.key === key) ?? brand.presets.find((p) => p.key === brand.defaultPreset) ?? DEFAULT_PRESETS[0];
}

/** A short block every prompt gets: who CARBON is and what it never does. */
export function brandBlock(brand: BrandBrain, presetKey?: string | null): string {
  const p = presetOf(brand, presetKey);
  const liked = brand.voice.samples.filter((s) => s.verdict === "up").map((s) => s.text).slice(0, 5);
  const disliked = brand.voice.samples.filter((s) => s.verdict === "down").map((s) => s.text).slice(0, 5);
  return [
    `BRAND: CARBON (shopcarbon.com) — streetwear, denim, luxury and evening wear from Orlando, Florida. Say "CARBON", never "Carbon Jeans".`,
    `LOOK (${p.name}): ${p.look}.`,
    `VOICE: ${brand.voice.description}.${liked.length ? ` Captions the owner liked: ${liked.map((t) => `"${t}"`).join(" · ")}.` : ""}${disliked.length ? ` Captions the owner disliked: ${disliked.map((t) => `"${t}"`).join(" · ")}.` : ""}`,
    `DO: ${brand.dos.join("; ")}.`,
    `DON'T: ${brand.donts.join("; ")}. Never name other brands, never say where the clothes are made.`,
  ].join("\n");
}
