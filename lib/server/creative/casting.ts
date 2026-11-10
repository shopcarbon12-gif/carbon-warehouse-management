/**
 * CarbonWMS Creative — Casting + Model Library (spec §7.1). The people are the Studio's own
 * models (models table: 4-view reference sheet face front / face turn / body front / body back);
 * creative_model_meta adds look, lanes, voice, personality, consent. Auto-cast fits the concept
 * and lane, and keeps variety: no model in more than 2 of the last 10 ads unless pinned, mixed
 * gender / look / body across a campaign, never the same UGC creator twice in a row.
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import sharp from "sharp";
import { z } from "zod";
import { downloadStorageObject, getStoragePublicUrl, tryGetStoragePathFromUrl } from "@/lib/storageProvider";
import { PlainError, recordSpend, spendGate } from "./config";
import { generateImage, TTS_VOICES } from "./engines";
import { json } from "./llm";
import { appFileUrl, fetchBytes, putFile, getFile } from "./storage";

export type CastModel = {
  id: string;
  name: string;
  gender: "female" | "male" | string;
  refs: string[]; // face_front, face_turn, body_front, body_back (URLs)
  ageRange: string | null;
  look: string | null;
  bodyType: string | null;
  hair: string | null;
  lanes: string[];
  voice: string | null;
  personality: string | null;
  isRealPerson: boolean;
  consent: boolean;
  pinned: boolean;
  active: boolean;
  height: string | null;
  size: string | null;
};

const ORDER = ["face_front", "face_turn", "body_front", "body_back"];

export async function listModels(pool: Pool, tenantId: string): Promise<CastModel[]> {
  const r = await pool.query(
    `SELECT m.model_id, m.name, m.gender, m.ref_image_urls, m.ref_slots,
            c.age_range, c.look, c.body_type, c.hair, c.lanes, c.voice, c.personality, c.is_real_person, c.consent, c.pinned, c.active,
            p.height, p.size
       FROM models m
       LEFT JOIN creative_model_meta c ON c.model_id = m.model_id AND c.tenant_id = $1::uuid
       LEFT JOIN model_profiles p ON lower(p.studio_model_name) = lower(m.name)
      ORDER BY m.created_at`,
    [tenantId],
  );
  return r.rows.map((x) => {
    const slots = (x.ref_slots ?? {}) as Record<string, string>;
    const refs = ORDER.map((k) => slots[k]).filter(Boolean);
    return {
      id: x.model_id,
      name: x.name,
      gender: x.gender,
      refs: refs.length ? refs : (x.ref_image_urls ?? []),
      ageRange: x.age_range ?? null,
      look: x.look ?? null,
      bodyType: x.body_type ?? null,
      hair: x.hair ?? null,
      lanes: x.lanes ?? [],
      voice: x.voice ?? null,
      personality: x.personality ?? null,
      isRealPerson: Boolean(x.is_real_person),
      consent: Boolean(x.consent),
      pinned: Boolean(x.pinned),
      active: x.active ?? true,
      height: x.height ?? null,
      size: x.size ?? null,
    };
  });
}

export async function modelRefBytes(m: CastModel, max = 4): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const u of m.refs.slice(0, max)) {
    try {
      const p = tryGetStoragePathFromUrl(u);
      const raw = p ? Buffer.from((await downloadStorageObject(p)).body) : u.startsWith("/api/creative/file") ? (await getFile(decodeURIComponent(u.split("p=")[1] ?? ""))).bytes : (await fetchBytes(u, 30 * 1024 * 1024)).bytes;
      out.push(await sharp(raw).rotate().resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 90 }).toBuffer());
    } catch {
      /* missing picture */
    }
  }
  return out;
}

/** Who appeared in the last N projects (most recent first). */
async function recentCasts(pool: Pool, tenantId: string, n = 10): Promise<{ cast_ids: string[]; kind: string }[]> {
  const r = await pool.query(`SELECT cast_ids, kind FROM creative_projects WHERE tenant_id = $1::uuid AND array_length(cast_ids, 1) > 0 ORDER BY created_at DESC LIMIT $2`, [tenantId, n]);
  return r.rows;
}

/**
 * Auto-cast. `count` people for a concept in `lane`, for products worn by `gender`
 * ("women" | "men" | "unisex"). `exclude` = people already used in this campaign (variety).
 */
export async function autoCast(
  pool: Pool,
  tenantId: string,
  opts: { lane: string | null; gender: string; count: number; kind: string; exclude?: string[]; pinned?: string[] },
): Promise<CastModel[]> {
  const all = (await listModels(pool, tenantId)).filter((m) => m.active && m.refs.length >= 2 && (!m.isRealPerson || m.consent));
  const recent = await recentCasts(pool, tenantId, 10);
  const uses = new Map<string, number>();
  for (const p of recent) for (const id of p.cast_ids) uses.set(id, (uses.get(id) ?? 0) + 1);
  const lastUgc = recent.find((p) => p.kind === "ugc")?.cast_ids ?? [];
  const want = opts.gender === "women" ? ["female"] : opts.gender === "men" ? ["male"] : ["female", "male"];
  const pinned = all.filter((m) => opts.pinned?.includes(m.id));
  const pool2 = all
    .filter((m) => !pinned.includes(m))
    .filter((m) => want.includes(m.gender))
    .filter((m) => m.pinned || (uses.get(m.id) ?? 0) < 2) // no more than 2 of the last 10 ads
    .filter((m) => !(opts.exclude ?? []).includes(m.id))
    .filter((m) => !(opts.kind === "ugc" && lastUgc.includes(m.id))); // UGC: not the same creator back-to-back
  const scored = pool2
    .map((m) => ({ m, s: (opts.lane && m.lanes.includes(opts.lane) ? 3 : 0) - (uses.get(m.id) ?? 0) + Math.random() * 1.5 }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
  const out: CastModel[] = [...pinned];
  // Mix gender / look / body when casting more than one person.
  for (const m of scored) {
    if (out.length >= opts.count) break;
    if (opts.count > 1 && want.length > 1 && out.length > 0 && out.filter((o) => o.gender === m.gender).length >= Math.ceil(opts.count / 2)) continue;
    if (out.some((o) => o.look && o.look === m.look && o.bodyType === m.bodyType)) continue;
    out.push(m);
  }
  for (const m of scored) if (out.length < opts.count && !out.includes(m)) out.push(m);
  // Variety rule can run out of people — then fall back to anyone of the right gender.
  if (!out.length) out.push(...all.filter((m) => want.includes(m.gender)).slice(0, opts.count));
  if (!out.length) throw new PlainError("No models with reference pictures yet. Add one in Creative → Settings → Models.");
  return out.slice(0, opts.count);
}

/* ------------------------------------------------------------------ add a model */

const CELEB_WORDS = /\b(look ?alike|like (a |the )?(famous|celebrity)|kardashian|beyonc|rihanna|drake|kanye|zendaya|timoth[eé]e|bieber|swift|bad bunny|travis scott|hadid|jenner)\b/i;

export const CANDIDATE_COST = 4 * 0.25;

/** "Describe it" / "random new face" → 4 headshot candidates the owner picks from (≈ $1). */
export async function modelCandidates(pool: Pool, tenantId: string, v: { description?: string; gender: "female" | "male"; lane?: string | null }): Promise<{ id: string; url: string }[]> {
  const desc = (v.description ?? "").trim();
  if (CELEB_WORDS.test(desc)) throw new PlainError("Celebrity or public-figure lookalikes are blocked. Describe the look instead (age, hair, style).");
  await spendGate(pool, tenantId, "openai", CANDIDATE_COST);
  const base = desc || `a new ${v.gender === "female" ? "woman" : "man"} model, ${v.lane ? v.lane.replace(/_/g, " ") : "streetwear"} look, varied ethnicity, natural skin texture`;
  const batch = crypto.randomUUID();
  const out: { id: string; url: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const g = await generateImage({
      prompt: `Fashion model casting headshot, front-facing, neutral confident expression, plain charcoal heather tee, light-grey seamless studio backdrop, soft even light, real skin texture, 85mm. Person: ${base}. Variation ${i + 1} of 4 — a clearly different face from the others. An ORIGINAL person who does not resemble any celebrity or public figure. No text, no logo.`,
      size: "1024x1024",
      quality: "medium",
    });
    await recordSpend(pool, tenantId, { provider: "openai", what: "model candidate headshot", cost: g.cost });
    const path = await putFile(`creative/models/candidates/${batch}/${i}.png`, g.bytes, "image/png");
    out.push({ id: path, url: appFileUrl(path)! });
  }
  return out;
}

const SHEET_VIEWS: { slot: string; prompt: string; size: "1024x1024" | "1024x1536" }[] = [
  { slot: "face_front", prompt: "straight-on headshot, looking at the camera", size: "1024x1024" },
  { slot: "face_turn", prompt: "three-quarter headshot, face turned about 40 degrees", size: "1024x1024" },
  { slot: "body_front", prompt: "full body, standing straight, facing the camera, arms relaxed, barefoot, fitted charcoal tee and charcoal shorts", size: "1024x1536" },
  { slot: "body_back", prompt: "full body from the back, standing straight, barefoot, fitted charcoal tee and charcoal shorts", size: "1024x1536" },
];
export const SHEET_COST = 4 * 0.25;

/** Picked headshot (or an uploaded real person, with consent) → 4-view reference sheet → a model. */
export async function createModel(
  pool: Pool,
  tenantId: string,
  v: { name: string; gender: "female" | "male"; headshot: Buffer; isRealPerson: boolean; consent: boolean; notCelebrity: boolean; by: string | null; look?: string; lanes?: string[]; personality?: string; voice?: string },
): Promise<string> {
  if (v.isRealPerson && !(v.consent && v.notCelebrity)) throw new PlainError("A real person needs their consent ticked, and must not be a celebrity or public figure.");
  if (CELEB_WORDS.test(v.name)) throw new PlainError("Celebrity or public-figure lookalikes are blocked.");
  await spendGate(pool, tenantId, "openai", SHEET_COST);
  const id = `cr_${crypto.randomUUID().slice(0, 12)}`;
  const slots: Record<string, string> = {};
  const head = await sharp(v.headshot).rotate().resize(1024, 1024, { fit: "inside" }).jpeg({ quality: 92 }).toBuffer();
  for (const view of SHEET_VIEWS) {
    const g = await generateImage({
      prompt: `Model reference sheet photo of EXACTLY the person in the reference picture (same face, skin tone, hair, body type, age): ${view.prompt}. Light-grey seamless studio backdrop, soft even light, real skin texture, no text, no logo.`,
      refs: [{ name: "person.jpg", bytes: head, mime: "image/jpeg" }],
      size: view.size,
      quality: "high",
    });
    await recordSpend(pool, tenantId, { provider: "openai", what: `model sheet ${v.name} (${view.slot})`, cost: g.cost });
    const p = await putFile(`creative/models/${id}/${view.slot}.png`, g.bytes, "image/png");
    slots[view.slot] = getStoragePublicUrl(p);
  }
  await pool.query(
    `INSERT INTO models (model_id, user_id, name, gender, ref_image_urls, ref_slots) VALUES ($1, '00000000-0000-0000-0000-000000000001', $2, $3, $4::jsonb, $5::jsonb)`,
    [id, v.name.slice(0, 40), v.gender, JSON.stringify(ORDER.map((k) => slots[k])), JSON.stringify(slots)],
  );
  await upsertMeta(pool, tenantId, id, {
    look: v.look ?? null,
    lanes: v.lanes ?? [],
    personality: v.personality ?? null,
    voice: v.voice ?? null,
    isRealPerson: v.isRealPerson,
    consent: v.consent,
    consentBy: v.isRealPerson ? v.by : null,
  });
  return id;
}

export async function upsertMeta(
  pool: Pool,
  tenantId: string,
  modelId: string,
  m: Partial<{ ageRange: string | null; look: string | null; bodyType: string | null; hair: string | null; lanes: string[]; voice: string | null; personality: string | null; isRealPerson: boolean; consent: boolean; consentBy: string | null; pinned: boolean; active: boolean }>,
) {
  if (m.voice && !(TTS_VOICES as readonly string[]).includes(m.voice)) throw new PlainError("Unknown voice.");
  await pool.query(
    `INSERT INTO creative_model_meta (tenant_id, model_id) VALUES ($1::uuid, $2) ON CONFLICT DO NOTHING`,
    [tenantId, modelId],
  );
  await pool.query(
    `UPDATE creative_model_meta SET
       age_range = COALESCE($3, age_range), look = COALESCE($4, look), body_type = COALESCE($5, body_type), hair = COALESCE($6, hair),
       lanes = COALESCE($7, lanes), voice = COALESCE($8, voice), personality = COALESCE($9, personality),
       is_real_person = COALESCE($10, is_real_person), consent = COALESCE($11, consent),
       consent_by = COALESCE($12, consent_by), consent_at = CASE WHEN $11 IS TRUE THEN now() ELSE consent_at END,
       pinned = COALESCE($13, pinned), active = COALESCE($14, active), updated_at = now()
     WHERE tenant_id = $1::uuid AND model_id = $2`,
    [tenantId, modelId, m.ageRange ?? null, m.look ?? null, m.bodyType ?? null, m.hair ?? null, m.lanes ?? null, m.voice ?? null, m.personality ?? null, m.isRealPerson ?? null, m.consent ?? null, m.consentBy ?? null, m.pinned ?? null, m.active ?? null],
  );
}

/** Fill in look / hair / body / lanes / personality for the existing Studio models (one cheap vision call each, on tap). */
export async function describeModel(pool: Pool, tenantId: string, m: CastModel): Promise<void> {
  const refs = await modelRefBytes(m, 3);
  if (!refs.length) return;
  const v = (
    await json(
      pool,
      `Describe this fashion model for a casting list (no names, no guesses about ethnicity beyond what a casting director would write). age_range like "25-30", look (3-6 words), body_type, hair, best style lanes from: streetwear, luxury, evening_going_out, denim, basics_minimal, athleisure, workwear_utility, y2k, western; personality for creator-style videos (one short phrase, e.g. "calm luxury girl", "hype streetwear guy").`,
      z.object({ age_range: z.string(), look: z.string(), body_type: z.string(), hair: z.string(), lanes: z.array(z.string()).max(4), personality: z.string() }),
      { tenantId, what: `describe model ${m.name}`, images: refs.map((b) => ({ b64: b.toString("base64") })), maxOutputTokens: 600 },
    )
  ).value;
  await upsertMeta(pool, tenantId, m.id, { ageRange: v.age_range, look: v.look, bodyType: v.body_type, hair: v.hair, lanes: v.lanes, personality: v.personality, voice: m.voice ?? (m.gender === "female" ? "coral" : "ash") });
}
