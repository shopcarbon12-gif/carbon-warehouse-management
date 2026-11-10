/**
 * Creative → Settings (profile icon) and the Brand Brain wizard.
 * GET  /api/creative/settings — caps, routing ("⋯ More"), sources, Brand Brain, models, locations,
 *      music + SFX, recipes, keys.
 * PUT  /api/creative/settings — change caps / routing / sources / category options / retention, or
 *      Brand Brain fields (presets, voice, do/don't, fonts, colours, edit style, wizard done).
 * POST /api/creative/settings {action} — the tap-to-run helpers: 10 sample captions to rate, preset
 *      sample frames, model candidates, create a model, model details, AI location, recipe approve /
 *      retire, delete a location / track, check fal for newer models.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withActivity } from "@/lib/server/activity-log";
import { guard, fail, body } from "@/lib/server/creative/http";
import { DEFAULT_CAPS, getBrand, getCreativeSettings, keysStatus, PlainError, presetOf, recordSpend, spendGate, brandBlock } from "@/lib/server/creative/config";
import { DEFAULT_ROUTES, VIDEO_ENGINES } from "@/lib/server/creative/routing";
import { SOURCE_DEFAULTS } from "@/lib/server/creative/radar/sources";
import { listModels, modelCandidates, createModel, upsertMeta, describeModel, CANDIDATE_COST, SHEET_COST } from "@/lib/server/creative/casting";
import { listAudio } from "@/lib/server/creative/audio";
import { listRecipes } from "@/lib/server/creative/recipes";
import { appFileUrl, getFile, putFile } from "@/lib/server/creative/storage";
import { generateImage, falCatalog, TTS_VOICES } from "@/lib/server/creative/engines";
import { json } from "@/lib/server/creative/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const tid = g.session.tid;
    const [settings, brand, models, audio, recipes, locations] = await Promise.all([
      getCreativeSettings(g.pool, tid),
      getBrand(g.pool, tid),
      listModels(g.pool, tid),
      listAudio(g.pool, tid),
      listRecipes(g.pool, tid),
      g.pool.query(`SELECT id::text, name, description, preset, storage_path, source FROM creative_locations WHERE tenant_id = $1::uuid ORDER BY created_at`, [tid]),
    ]);
    return NextResponse.json({
      settings,
      defaults: { caps: DEFAULT_CAPS, routes: DEFAULT_ROUTES, engines: VIDEO_ENGINES, sources: SOURCE_DEFAULTS },
      keys: keysStatus(),
      brand: {
        ...brand,
        presets: brand.presets.map((p) => ({ ...p, sampleUrls: p.samples.map((s) => appFileUrl(s)) })),
        logoUrls: brand.logos,
        headlineFontUrl: appFileUrl(brand.fonts.headlineFile ?? null),
      },
      models,
      voices: TTS_VOICES,
      audio: audio.map((a) => ({ ...a, url: appFileUrl(a.storage_path) })),
      recipes,
      locations: locations.rows.map((l) => ({ ...l, url: appFileUrl(l.storage_path) })),
      costs: { candidates: CANDIDATE_COST, sheet: SHEET_COST },
    });
  } catch (e) {
    return fail(e);
  }
}

const capSchema = z.object({ daily: z.number().min(0).max(1000), monthly: z.number().min(0).max(10000) });
const presetSchema = z.object({
  key: z.string().max(30),
  name: z.string().max(60),
  look: z.string().max(400),
  grade: z.object({ contrast: z.number().min(0.5).max(2), saturation: z.number().min(0).max(2), brightness: z.number().min(-0.5).max(0.5), warmth: z.number().min(-0.5).max(0.5), grain: z.number().min(0).max(1) }),
  pacing: z.enum(["fast", "medium", "slow"]),
  samples: z.array(z.string()).max(8),
});
const putSchema = z
  .object({
    caps: z.object({ openai: capSchema, fal: capSchema }).optional(),
    routing: z.record(z.string(), z.array(z.string())).optional(),
    sources: z.record(z.string(), z.object({ enabled: z.boolean(), apifyFallback: z.boolean().optional() })).optional(),
    categoryOptions: z.object({ bags: z.boolean(), hats: z.boolean(), belts: z.boolean() }).optional(),
    retentionDays: z.number().int().min(30).max(730).optional(),
    metaCountries: z.array(z.string().length(2)).max(27).optional(),
    brand: z
      .object({
        presets: z.array(presetSchema).min(1).max(8).optional(),
        defaultPreset: z.string().max(30).optional(),
        voice: z.object({ description: z.string().max(300), samples: z.array(z.object({ text: z.string().max(300), verdict: z.enum(["up", "down"]).nullable() })).max(20) }).optional(),
        dos: z.array(z.string().max(160)).max(30).optional(),
        donts: z.array(z.string().max(160)).max(30).optional(),
        fonts: z.object({ headline: z.string().max(60), body: z.string().max(60), headlineFile: z.string().nullable().optional(), bodyFile: z.string().nullable().optional() }).optional(),
        colors: z.record(z.string(), z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
        editStyle: z.record(z.string(), z.unknown()).optional(),
        platform: z.object({ default: z.string(), tiktok: z.boolean() }).optional(),
        wizardDone: z.boolean().optional(),
      })
      .optional(),
  })
  .strict();

async function PUT_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  try {
    const b = await body(req, putSchema);
    const tid = g.session.tid;
    for (const [k, engines] of Object.entries(b.routing ?? {})) if (!(k in DEFAULT_ROUTES) || engines.some((e) => !VIDEO_ENGINES[e])) throw new PlainError("Unknown engine in routing.");
    await getCreativeSettings(g.pool, tid);
    await g.pool.query(
      `UPDATE creative_settings SET caps = COALESCE($2::jsonb, caps), routing = COALESCE($3::jsonb, routing), sources = COALESCE($4::jsonb, sources),
              category_options = COALESCE($5::jsonb, category_options), retention_days = COALESCE($6, retention_days), meta_countries = COALESCE($7, meta_countries),
              updated_at = now(), updated_by = $8 WHERE tenant_id = $1::uuid`,
      [tid, b.caps ? JSON.stringify(b.caps) : null, b.routing ? JSON.stringify(b.routing) : null, b.sources ? JSON.stringify(b.sources) : null, b.categoryOptions ? JSON.stringify(b.categoryOptions) : null, b.retentionDays ?? null, b.metaCountries?.map((c) => c.toUpperCase()) ?? null, g.session.email ?? null],
    );
    if (b.brand) {
      await getBrand(g.pool, tid);
      const x = b.brand;
      await g.pool.query(
        `UPDATE creative_brand SET presets = COALESCE($2::jsonb, presets), default_preset = COALESCE($3, default_preset), voice = COALESCE($4::jsonb, voice),
                dos = COALESCE($5, dos), donts = COALESCE($6, donts), fonts = COALESCE($7::jsonb, fonts), colors = COALESCE($8::jsonb, colors),
                edit_style = COALESCE($9::jsonb, edit_style), platform = COALESCE($10::jsonb, platform), wizard_done = COALESCE($11, wizard_done),
                updated_at = now(), updated_by = $12 WHERE tenant_id = $1::uuid`,
        [
          tid, x.presets ? JSON.stringify(x.presets) : null, x.defaultPreset ?? null, x.voice ? JSON.stringify(x.voice) : null, x.dos ?? null, x.donts ?? null,
          x.fonts ? JSON.stringify(x.fonts) : null, x.colors ? JSON.stringify(x.colors) : null, x.editStyle ? JSON.stringify(x.editStyle) : null, x.platform ? JSON.stringify(x.platform) : null,
          x.wizardDone ?? null, g.session.email ?? null,
        ],
      );
    }
    return NextResponse.json({ settings: await getCreativeSettings(g.pool, tid), brand: await getBrand(g.pool, tid) });
  } catch (e) {
    return fail(e);
  }
}

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("voice_samples") }),
  z.object({ action: z.literal("preset_samples"), preset: z.string().max(30) }),
  z.object({ action: z.literal("model_candidates"), gender: z.enum(["female", "male"]), description: z.string().max(400).optional(), lane: z.string().max(40).nullable().optional() }),
  z.object({ action: z.literal("create_model"), name: z.string().min(1).max(40), gender: z.enum(["female", "male"]), candidatePath: z.string().max(300), look: z.string().max(120).optional(), lanes: z.array(z.string()).max(4).optional(), personality: z.string().max(120).optional(), voice: z.string().max(20).optional() }),
  z.object({ action: z.literal("model_meta"), modelId: z.string().max(60), pinned: z.boolean().optional(), active: z.boolean().optional(), voice: z.string().max(20).optional(), personality: z.string().max(120).optional(), lanes: z.array(z.string()).max(6).optional(), look: z.string().max(120).optional() }),
  z.object({ action: z.literal("describe_models") }),
  z.object({ action: z.literal("location_ai"), name: z.string().min(1).max(80), description: z.string().max(400), preset: z.string().max(30).nullable().optional() }),
  z.object({ action: z.literal("location_text"), name: z.string().min(1).max(80), description: z.string().max(400) }),
  z.object({ action: z.literal("location_delete"), id: z.string().uuid() }),
  z.object({ action: z.literal("audio_delete"), id: z.string().uuid() }),
  z.object({ action: z.literal("audio_tags"), id: z.string().uuid(), moods: z.array(z.string().max(40)).max(8) }),
  z.object({ action: z.literal("recipe_status"), key: z.string().max(80), status: z.enum(["active", "retired"]) }),
  z.object({ action: z.literal("catalog_check") }),
]);

async function POST_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const tid = g.session.tid;
  try {
    const a = await body(req, actionSchema);
    switch (a.action) {
      case "voice_samples": {
        const brand = await getBrand(g.pool, tid);
        const r = await json(
          g.pool,
          `${brandBlock(brand)}\n\nWrite 10 short Instagram captions for CARBON in different tones (some street, some luxury, some playful, some bold), so the owner can rate them 👍/👎 and the app learns the voice. No products named, no prices, no emojis overload.`,
          z.object({ captions: z.array(z.string().max(220)).length(10) }),
          { tenantId: tid, what: "brand brain: 10 sample captions", estimate: 0.02, maxOutputTokens: 1200 },
        );
        return NextResponse.json({ samples: r.value.captions.map((text) => ({ text, verdict: null })), cost: r.cost });
      }
      case "preset_samples": {
        const brand = await getBrand(g.pool, tid);
        const p = presetOf(brand, a.preset);
        const cost = 2 * 0.07;
        await spendGate(g.pool, tid, "openai", cost);
        const samples: string[] = [];
        for (const scene of ["a model in dark denim and a black hoodie walking toward camera", "a close-up of folded jeans and a jacket on a surface"]) {
          const img = await generateImage({ prompt: `Fashion campaign sample frame for the "${p.name}" look: ${p.look}. ${scene}. Photoreal, no text, no logos.`, size: "1024x1536", quality: "medium" });
          await recordSpend(g.pool, tid, { provider: "openai", what: `preset sample (${p.name})`, cost: img.cost });
          samples.push(await putFile(`creative/brand/${tid}/preset-${p.key}-${Date.now()}-${samples.length}.png`, img.bytes, "image/png"));
        }
        const presets = brand.presets.map((x) => (x.key === p.key ? { ...x, samples } : x));
        await g.pool.query(`UPDATE creative_brand SET presets = $2::jsonb, updated_at = now() WHERE tenant_id = $1::uuid`, [tid, JSON.stringify(presets)]);
        return NextResponse.json({ samples: samples.map((s) => appFileUrl(s)) });
      }
      case "model_candidates":
        return NextResponse.json({ candidates: await modelCandidates(g.pool, tid, { gender: a.gender, description: a.description, lane: a.lane ?? null }) });
      case "create_model": {
        if (!a.candidatePath.startsWith("creative/models/candidates/")) throw new PlainError("Pick one of the candidates.");
        const head = (await getFile(a.candidatePath)).bytes;
        const id = await createModel(g.pool, tid, { name: a.name, gender: a.gender, headshot: head, isRealPerson: false, consent: false, notCelebrity: true, by: g.session.email ?? null, look: a.look, lanes: a.lanes, personality: a.personality, voice: a.voice });
        return NextResponse.json({ modelId: id });
      }
      case "model_meta":
        await upsertMeta(g.pool, tid, a.modelId, { pinned: a.pinned, active: a.active, voice: a.voice, personality: a.personality, lanes: a.lanes, look: a.look });
        return NextResponse.json({ ok: true });
      case "describe_models": {
        const models = (await listModels(g.pool, tid)).filter((m) => !m.look && m.refs.length);
        for (const m of models.slice(0, 15)) await describeModel(g.pool, tid, m);
        return NextResponse.json({ described: Math.min(15, models.length) });
      }
      case "location_ai": {
        const brand = await getBrand(g.pool, tid);
        const p = presetOf(brand, a.preset ?? null);
        await spendGate(g.pool, tid, "openai", 0.25);
        const img = await generateImage({ prompt: `Empty location plate for a fashion shoot (no people): ${a.name} — ${a.description}. ${p.look}. Photoreal, wide, no text, no logos.`, size: "1536x1024", quality: "high" });
        await recordSpend(g.pool, tid, { provider: "openai", what: `location ${a.name}`, cost: img.cost });
        const path = await putFile(`creative/locations/${tid}/${Date.now()}.png`, img.bytes, "image/png");
        await g.pool.query(`INSERT INTO creative_locations (tenant_id, name, description, preset, storage_path, source) VALUES ($1::uuid, $2, $3, $4, $5, 'ai')`, [tid, a.name, a.description, a.preset ?? null, path]);
        return NextResponse.json({ ok: true, url: appFileUrl(path) });
      }
      case "location_text":
        await g.pool.query(`INSERT INTO creative_locations (tenant_id, name, description, source) VALUES ($1::uuid, $2, $3, 'ai')`, [tid, a.name, a.description]);
        return NextResponse.json({ ok: true });
      case "location_delete":
        await g.pool.query(`DELETE FROM creative_locations WHERE id = $1::uuid AND tenant_id = $2::uuid`, [a.id, tid]);
        return NextResponse.json({ ok: true });
      case "audio_delete":
        await g.pool.query(`DELETE FROM creative_audio WHERE id = $1::uuid AND tenant_id = $2::uuid`, [a.id, tid]);
        return NextResponse.json({ ok: true });
      case "audio_tags":
        await g.pool.query(`UPDATE creative_audio SET moods = $3 WHERE id = $1::uuid AND tenant_id = $2::uuid`, [a.id, tid, a.moods.map((m) => m.toLowerCase())]);
        return NextResponse.json({ ok: true });
      case "recipe_status":
        await g.pool.query(`UPDATE creative_recipes SET status = $3 WHERE tenant_id = $1::uuid AND key = $2`, [tid, a.key, a.status]);
        return NextResponse.json({ ok: true });
      case "catalog_check": {
        const found = [...(await falCatalog("kling")), ...(await falCatalog("veo")), ...(await falCatalog("seedance"))];
        const known = new Set(Object.keys(VIDEO_ENGINES));
        const newer = found.filter((m) => !known.has(m.id) && /image-to-video|reference-to-video/.test(m.id));
        return NextResponse.json({ checked: found.length, newer, note: found.length ? null : "fal.ai's model list didn't answer (needs FAL_KEY) — nothing changed." });
      }
    }
  } catch (e) {
    return fail(e);
  }
}

export const PUT = withActivity("creative/settings", PUT_handler);
export const POST = withActivity("creative/settings", POST_handler);
