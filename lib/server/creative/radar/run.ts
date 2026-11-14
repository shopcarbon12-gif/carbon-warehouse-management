/**
 * Radar — the jobs: nightly collection (no paid AI), one-time tagging through the OpenAI Batch
 * API (50% off), retention purge. Every source run writes real counts to creative_source_runs.
 */
import type { Pool } from "pg";
import sharp from "sharp";
import { deleteStorageObjects } from "@/lib/storageProvider";
import { getCreativeSettings, recordSpend, spendGate } from "../config";
import { enqueue, type JobHandler } from "../jobs";
import { collectBatch, embed, parseLenient, submitBatch, type LlmImage } from "../llm";
import { getFile } from "../storage";
import { textCost } from "../routing";
import { ANALYSIS_PROMPT, decide, landingSignal } from "./classify";
import { emptyCounts, finishRun, ingestAd, startRun } from "./ingest";
import { ADAPTERS, SOURCE_DEFAULTS } from "./sources";
import { AdAnalysis, CREATIVE_PATTERNS, DISCOVERY_TERMS, SEED_BRANDS } from "./taxonomy";

export async function ensureSeedBrands(pool: Pool, tenantId: string): Promise<number> {
  let n = 0;
  for (const g of SEED_BRANDS)
    for (const name of g.names) {
      const r = await pool.query(
        `INSERT INTO creative_ad_brands (tenant_id, name, lane, prior, found_by) VALUES ($1::uuid, $2, $3, $4, 'seed') ON CONFLICT DO NOTHING`,
        [tenantId, name, g.lane, g.prior],
      );
      n += r.rowCount ?? 0;
    }
  return n;
}

export function sourceEnabled(settings: { sources: Record<string, { enabled: boolean }> }, key: string): boolean {
  return settings.sources[key]?.enabled ?? SOURCE_DEFAULTS[key]?.enabled ?? false;
}

/** radar_source: one brand (or keyword) on one source. */
export const radarSource: JobHandler = async (pool, job, setProgress) => {
  const { source, brandId, keyword, limit } = job.payload as { source: string; brandId?: string; keyword?: string; limit?: number };
  const adapter = ADAPTERS[source];
  if (!adapter) throw new Error(`unknown source ${source}`);
  const settings = await getCreativeSettings(pool, job.tenant_id);
  const brand = brandId
    ? (await pool.query(`SELECT id::text, name, meta_page_ids, handles FROM creative_ad_brands WHERE id = $1::uuid AND tenant_id = $2::uuid`, [brandId, job.tenant_id])).rows[0] ?? null
    : null;
  const runId = await startRun(pool, job.tenant_id, source, brand?.id ?? null);
  const counts = emptyCounts();
  const log: string[] = [];
  const known = new Set(
    (await pool.query<{ n: string }>(`SELECT lower(name) AS n FROM creative_ad_brands WHERE tenant_id = $1::uuid`, [job.tenant_id])).rows.map((r) => r.n),
  );
  await setProgress(`${adapter.label}: ${brand?.name ?? keyword}`);
  try {
    for await (const ad of adapter.discover({ pool, tenantId: job.tenant_id, brand, keyword: keyword ?? null, countries: settings.metaCountries, limit: limit ?? 30, log: (m) => log.push(m) })) {
      counts.discovered++;
      // Keyword discovery: a new advertiser goes to the approve / reject queue, not the library.
      if (!brand && ad.advertiser && !known.has(ad.advertiser.toLowerCase())) {
        await pool.query(
          `INSERT INTO creative_ad_brands (tenant_id, name, status, prior, found_by) VALUES ($1::uuid, $2, 'pending', 'unknown', $3) ON CONFLICT DO NOTHING`,
          [job.tenant_id, ad.advertiser.slice(0, 120), `keyword: ${keyword} (${source})`],
        );
        known.add(ad.advertiser.toLowerCase());
        log.push(`new advertiser for review: ${ad.advertiser}`);
        continue;
      }
      if (!brand) {
        const b = await pool.query<{ id: string; status: string }>(`SELECT id::text, status FROM creative_ad_brands WHERE tenant_id = $1::uuid AND lower(name) = lower($2)`, [job.tenant_id, ad.advertiser]);
        if (b.rows[0]?.status !== "active") continue;
        ad.brandId = b.rows[0].id;
      } else ad.brandId = brand.id;
      const res = await ingestAd(pool, job.tenant_id, ad);
      if (res === "noMedia") counts.mediaFailed++;
      else counts[res]++;
      if (res === "preRejected") log.push(`rejected (free pre-check): ${ad.advertiser} — ${ad.headline.slice(0, 60) || ad.body.slice(0, 60)}`);
      if (counts.discovered % 5 === 0) await setProgress(`${adapter.label}: ${brand?.name ?? keyword} — ${counts.discovered} found, ${counts.new} new`);
    }
    if (brand) await pool.query(`UPDATE creative_ad_brands SET last_refreshed_at = now() WHERE id = $1::uuid`, [brand.id]);
    await finishRun(pool, runId, counts, null, log);
  } catch (e) {
    await finishRun(pool, runId, counts, (e as Error).message.slice(0, 500), log);
    throw e;
  }
  // New ads wait for the next tagging batch.
  if (counts.new > 0) await queueTagging(pool, job.tenant_id, job.requested_by);
  return { status: "done", result: counts, progress: `${counts.discovered} found · ${counts.new} new · ${counts.merged} merged · ${counts.seen} already known` };
};

export async function queueTagging(pool: Pool, tenantId: string, by: string | null) {
  const open = await pool.query(`SELECT 1 FROM creative_jobs WHERE tenant_id = $1::uuid AND kind = 'radar_tag' AND status IN ('queued','waiting','running') LIMIT 1`, [tenantId]);
  if (!open.rows[0]) await enqueue(pool, tenantId, "radar_tag", {}, { requestedBy: by, afterSeconds: 300, progress: "Waiting for more new ads before tagging (one batch, half price)" });
}

/** radar_nightly: every active brand × enabled source, plus keyword discovery. No paid AI. */
export const radarNightly: JobHandler = async (pool, job) => {
  await ensureSeedBrands(pool, job.tenant_id);
  const settings = await getCreativeSettings(pool, job.tenant_id);
  const { brandId } = job.payload as { brandId?: string };
  const brands = await pool.query<{ id: string }>(
    `SELECT id::text FROM creative_ad_brands WHERE tenant_id = $1::uuid AND status = 'active' AND ($2::uuid IS NULL OR id = $2::uuid) ORDER BY last_refreshed_at NULLS FIRST, name`,
    [job.tenant_id, brandId ?? null],
  );
  const sources = Object.entries(SOURCE_DEFAULTS)
    .filter(([k]) => sourceEnabled(settings, k))
    .sort((a, b) => a[1].priority - b[1].priority)
    .map(([k]) => k);
  let n = 0;
  for (const s of sources) {
    for (const b of brands.rows) {
      await enqueue(pool, job.tenant_id, "radar_source", { source: s, brandId: b.id, limit: brandId ? 50 : 25 }, { requestedBy: job.requested_by });
      n++;
    }
    if (!brandId && (s === "meta_library" || s === "tiktok_top"))
      for (const kw of DISCOVERY_TERMS) {
        await enqueue(pool, job.tenant_id, "radar_source", { source: s, keyword: kw, limit: 15 }, { requestedBy: job.requested_by });
        n++;
      }
  }
  if (!brandId) await enqueue(pool, job.tenant_id, "radar_retention", {}, { requestedBy: job.requested_by });
  return { status: "done", result: { jobs: n }, progress: `${n} source jobs queued (${sources.join(", ") || "no source switched on"})` };
};

/* ------------------------------------------------------------------ tagging (Batch API) */

async function adImages(media: { kind: string; storage_path: string; keyframes?: string[]; poster_path?: string }[]): Promise<LlmImage[]> {
  const paths: string[] = [];
  for (const m of media.slice(0, 4)) {
    if (m.kind === "video") paths.push(...(m.keyframes?.length ? m.keyframes : m.poster_path ? [m.poster_path] : []));
    else paths.push(m.storage_path);
  }
  const out: LlmImage[] = [];
  for (const p of paths.slice(0, 6)) {
    try {
      const { bytes } = await getFile(p);
      const small = await sharp(bytes).rotate().resize(512, 512, { fit: "inside" }).jpeg({ quality: 72 }).toBuffer();
      out.push({ b64: small.toString("base64"), mime: "image/jpeg" });
    } catch {
      /* skip */
    }
  }
  return out;
}

export const radarTag: JobHandler = async (pool, job, setProgress) => {
  const p = job.payload as { batchId?: string; adIds?: string[]; model?: string };
  if (!p.batchId) {
    const ads = await pool.query(
      `SELECT a.id::text, a.advertiser, a.headline, a.body, a.cta, a.landing_url, a.media, a.media_type, b.prior
         FROM creative_ads a LEFT JOIN creative_ad_brands b ON b.id = a.brand_id
        WHERE a.tenant_id = $1::uuid AND a.status = 'new' ORDER BY a.created_at LIMIT 300`,
      [job.tenant_id],
    );
    if (!ads.rows.length) return { status: "done", progress: "Nothing new to tag" };
    // ≈ 3k input tokens (6 small pictures) + 600 out per ad, at batch price.
    await spendGate(pool, job.tenant_id, "openai", ads.rows.length * textCost("gpt-5.5", 3000, 600, true));
    await setProgress(`Preparing ${ads.rows.length} ads for tagging`);
    const lines = [];
    const landing: Record<string, unknown> = {};
    for (const a of ads.rows) {
      const ls = await landingSignal(a.landing_url);
      if (ls) landing[a.id] = ls;
      const images = await adImages(a.media);
      lines.push({
        customId: a.id,
        prompt: ANALYSIS_PROMPT({ advertiser: a.advertiser, headline: a.headline, body: a.body, cta: a.cta, landing: ls?.text ?? null, mediaKind: (a.media?.[0]?.kind ?? "image") === "video" ? "video" : a.media?.length > 1 ? "carousel" : "static", frames: images.length }),
        images,
        schema: AdAnalysis,
      });
    }
    const { batchId, model } = await submitBatch(lines, { purpose: "radar_tag", tenant: job.tenant_id });
    return {
      status: "waiting",
      afterSeconds: 600,
      progress: `Tagging ${lines.length} ads with the OpenAI Batch API (half price, up to 24 h)`,
      payload: { batchId, adIds: ads.rows.map((r) => r.id), model, landing },
    };
  }
  const out = await collectBatch(p.batchId);
  if (out.state === "pending") return { status: "waiting", afterSeconds: 600, progress: `OpenAI batch ${out.status}` };
  if (out.state === "failed") throw new Error(`The tagging batch ${out.status}: ${out.error}`);
  const settings = await getCreativeSettings(pool, job.tenant_id);
  const landing = ((job.payload as { landing?: Record<string, { apparel: boolean; blocked: string | null; text: string }> }).landing) ?? {};
  let cost = 0, kept = 0, review = 0, rejected = 0, failed = 0;
  const embedQueue: { id: string; text: string }[] = [];
  for (const r of out.results) {
    cost += textCost(p.model ?? "gpt-5.5", r.inTok, r.outTok, true);
    const parsed = r.ok ? parseLenient(AdAnalysis, r.value) : null;
    if (!parsed?.success) {
      failed++;
      await pool.query(`UPDATE creative_ads SET status = 'review', reject_reason = $2, updated_at = now() WHERE id = $1::uuid AND status = 'new'`, [r.customId, `tagging failed: ${r.error ?? parsed?.error.issues[0]?.message ?? "bad answer"}`]);
      continue;
    }
    const a = parsed.data;
    const prior = (await pool.query<{ prior: string | null }>(`SELECT b.prior FROM creative_ads a LEFT JOIN creative_ad_brands b ON b.id = a.brand_id WHERE a.id = $1::uuid`, [r.customId])).rows[0]?.prior ?? null;
    const d = decide(a, { prior, landing: landing[r.customId] ?? null, optional: settings.categoryOptions });
    if (d.status === "kept") kept++;
    else if (d.status === "review") review++;
    else rejected++;
    const searchExtra = [a.hook_text, a.structure_summary, a.creative_pattern.join(" "), a.style_lane, a.items_visible.join(" ")].join(" ");
    await pool.query(
      `UPDATE creative_ads SET status = $2, reject_reason = $3, category = $4::jsonb, tags = $5::jsonb, media_type = $6, tagged_at = now(),
              search_text = left(advertiser || ' ' || headline || ' ' || body || ' ' || $7, 8000), updated_at = now()
        WHERE id = $1::uuid`,
      [r.customId, d.status, d.status === "kept" ? null : d.reason, JSON.stringify({ product_category: a.product_category, confidence: d.confidence, items_visible: a.items_visible, decision: d.reason }), JSON.stringify(a), a.media_type, searchExtra],
    );
    if (d.status !== "rejected") embedQueue.push({ id: r.customId, text: `${a.style_lane} ${a.media_type} ${a.creative_pattern.join(" ")} ${a.hook_text} ${a.structure_summary}` });
  }
  await recordSpend(pool, job.tenant_id, { provider: "openai", what: `radar tagging batch (${out.results.length} ads)`, cost });
  for (let i = 0; i < embedQueue.length; i += 100) {
    const chunk = embedQueue.slice(i, i + 100);
    const vecs = await embed(pool, job.tenant_id, chunk.map((c) => c.text)).catch(() => []);
    for (const [k, v] of vecs.entries()) await pool.query(`UPDATE creative_ads SET embedding = $2 WHERE id = $1::uuid`, [chunk[k].id, v]);
  }
  await proposeRecipes(pool, job.tenant_id);
  return { status: "done", result: { kept, review, rejected, failed, cost }, progress: `Tagged: ${kept} kept · ${review} to review · ${rejected} rejected${failed ? ` · ${failed} failed` : ""} ($${cost.toFixed(2)})` };
};

/** Spec §7.3: a high-scoring structure that isn't in the library → proposed recipe (owner approves). */
export async function proposeRecipes(pool: Pool, tenantId: string): Promise<number> {
  const known = new Set((await pool.query<{ key: string }>(`SELECT key FROM creative_recipes WHERE tenant_id = $1::uuid`, [tenantId])).rows.map((r) => r.key));
  const r = await pool.query<{ id: string; tags: { creative_pattern: string[]; structure_summary: string; media_type: string }; winner_score: number }>(
    `SELECT id::text, tags, winner_score FROM creative_ads WHERE tenant_id = $1::uuid AND status = 'kept' AND winner_score >= 70 AND tags IS NOT NULL ORDER BY winner_score DESC LIMIT 200`,
    [tenantId],
  );
  let n = 0;
  for (const ad of r.rows) {
    for (const pat of ad.tags.creative_pattern ?? []) {
      if ((CREATIVE_PATTERNS as readonly string[]).includes(pat)) continue; // known patterns map to the seed recipes
      const key = `radar_${pat}`.slice(0, 60);
      if (known.has(key)) continue;
      known.add(key);
      await pool.query(
        `INSERT INTO creative_recipes (tenant_id, key, name, idea, media_types, structure, status, source_ad_id, score)
         VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, 'proposed', $7::uuid, $8) ON CONFLICT DO NOTHING`,
        [tenantId, key, pat.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()), ad.tags.structure_summary, [ad.tags.media_type === "static" ? "static" : "video"], JSON.stringify({ from_radar: true, beats: [] }), ad.id, ad.winner_score],
      );
      n++;
    }
  }
  return n;
}

/** radar_retention: drop media of inactive ads unseen for N days (metadata kept). */
export const radarRetention: JobHandler = async (pool, job) => {
  const settings = await getCreativeSettings(pool, job.tenant_id);
  const r = await pool.query<{ id: string; media: { storage_path?: string; poster_path?: string; keyframes?: string[] }[] }>(
    `SELECT id::text, media FROM creative_ads WHERE tenant_id = $1::uuid AND media_purged_at IS NULL AND is_active IS NOT TRUE
        AND COALESCE(last_seen, created_at::date) < (now() - make_interval(days => $2))::date
        AND id NOT IN (SELECT ad_id FROM creative_board_items) LIMIT 500`,
    [job.tenant_id, settings.retentionDays],
  );
  for (const ad of r.rows) {
    const paths = ad.media.flatMap((m) => [m.storage_path, m.poster_path, ...(m.keyframes ?? [])]).filter(Boolean) as string[];
    if (paths.length) await deleteStorageObjects(paths).catch(() => {});
    await pool.query(`UPDATE creative_ads SET media = '[]'::jsonb, media_purged_at = now() WHERE id = $1::uuid`, [ad.id]);
  }
  return { status: "done", progress: `${r.rows.length} old inactive ads' media removed (details kept)` };
};
