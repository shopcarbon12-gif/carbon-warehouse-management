/**
 * Radar — one normalized `ads` schema for every source (spec §4). Adapters hand in NormalizedAd;
 * ingest copies the media to R2 (platform URLs expire — never hotlink), fingerprints it and
 * collapses duplicates (pHash / keyframe pHash + advertiser + normalized headline) into one ad
 * with N variations across M platforms.
 */
import crypto from "node:crypto";
import type { Pool } from "pg";
import { extFor, fetchBytes, getFile, putFile } from "../storage";
import { hamming, keyframes, phash, SAME_IMAGE } from "../media";
import { textPreCheck } from "./classify";
import { daysRunning, winnerScore } from "./score";

export type NormalizedMedia = { kind: "image" | "video"; url: string; poster?: string | null };
export type NormalizedAd = {
  source: string;
  externalId: string;
  platforms: string[];
  advertiser: string;
  brandId?: string | null;
  headline: string;
  body: string;
  cta?: string | null;
  landingUrl?: string | null;
  media: NormalizedMedia[];
  firstSeen?: string | null;
  lastSeen?: string | null;
  isActive?: boolean | null;
  countries?: string[];
  metrics?: Record<string, number | string | null>;
  sourceUrl?: string | null;
  raw?: unknown;
};

export interface SourceAdapter {
  key: string;
  label: string;
  /** Finds ads for one brand (or a keyword) — yields normalized ads. */
  discover(ctx: AdapterCtx): AsyncGenerator<NormalizedAd>;
}
export type AdapterCtx = {
  pool: Pool;
  tenantId: string;
  brand: { id: string; name: string; meta_page_ids: string[]; handles: Record<string, string> } | null;
  keyword: string | null;
  countries: string[];
  limit: number;
  log: (msg: string) => void;
};

export type RunCounts = { discovered: number; new: number; merged: number; seen: number; preRejected: number; mediaFailed: number };
export const emptyCounts = (): RunCounts => ({ discovered: 0, new: 0, merged: 0, seen: 0, preRejected: 0, mediaFailed: 0 });

export const normHeadline = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

const iso = (d: string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

async function copyMedia(tenantId: string, adKey: string, media: NormalizedMedia[]): Promise<{ stored: Record<string, unknown>[]; hash: string | null; failed: number }> {
  const stored: Record<string, unknown>[] = [];
  let hash: string | null = null;
  let failed = 0;
  for (const [i, m] of media.slice(0, 6).entries()) {
    try {
      // "stored:<path>" = a file the owner uploaded (manual import), already in R2.
      const { bytes, contentType } = m.url.startsWith("stored:") ? await getFile(m.url.slice(7)) : await fetchBytes(m.url, m.kind === "video" ? 120 * 1024 * 1024 : 25 * 1024 * 1024);
      const ext = extFor(contentType, m.kind === "video" ? "mp4" : "jpg");
      const p = await putFile(`creative/radar/${tenantId}/${adKey}/${i}.${ext}`, bytes, contentType);
      const item: Record<string, unknown> = { kind: m.kind, storage_path: p };
      if (m.kind === "video") {
        const k = await keyframes(bytes, 4).catch(() => null);
        if (k) {
          item.duration = k.duration;
          item.w = k.width;
          item.h = k.height;
          if (k.frames[0]) {
            item.poster_path = await putFile(`creative/radar/${tenantId}/${adKey}/${i}-poster.jpg`, k.frames[0], "image/jpeg");
            hash ??= await phash(k.frames[Math.min(1, k.frames.length - 1)]);
          }
          item.keyframes = await Promise.all(k.frames.map((f, j) => putFile(`creative/radar/${tenantId}/${adKey}/${i}-k${j}.jpg`, f, "image/jpeg")));
        }
      } else {
        hash ??= await phash(bytes).catch(() => null);
      }
      stored.push(item);
    } catch {
      failed++;
    }
  }
  return { stored, hash, failed };
}

/** Insert or merge one sighting. Returns what happened, for the run log. */
export async function ingestAd(pool: Pool, tenantId: string, ad: NormalizedAd): Promise<"seen" | "new" | "merged" | "preRejected" | "noMedia"> {
  const seen = await pool.query<{ id: string; ad_id: string }>(`SELECT id, ad_id FROM creative_ad_variations WHERE source = $1 AND external_id = $2`, [ad.source, ad.externalId]);
  if (seen.rows[0]) {
    await pool.query(
      `UPDATE creative_ad_variations SET last_seen = GREATEST(last_seen, $2::date), is_active = COALESCE($3, is_active) WHERE id = $1::uuid`,
      [seen.rows[0].id, iso(ad.lastSeen) ?? iso(new Date().toISOString()), ad.isActive ?? null],
    );
    await refreshAd(pool, seen.rows[0].ad_id);
    return "seen";
  }
  const adKey = crypto.randomUUID();
  const text = `${ad.headline} ${ad.body}`;
  const pre = textPreCheck(text);
  const { stored, hash } = pre.blocked ? { stored: [], hash: null } : await copyMedia(tenantId, adKey, ad.media);
  if (!pre.blocked && !stored.length && ad.media.length) return "noMedia";
  const headlineNorm = normHeadline(ad.headline || ad.body.slice(0, 120));

  // Duplicate? Same advertiser and the same picture (pHash) or the same headline.
  if (!pre.blocked) {
    const cands = await pool.query<{ id: string; phash: string | null; headline_norm: string }>(
      `SELECT id, phash, headline_norm FROM creative_ads WHERE tenant_id = $1::uuid AND lower(advertiser) = lower($2) ORDER BY created_at DESC LIMIT 400`,
      [tenantId, ad.advertiser],
    );
    const dup = cands.rows.find((c) => (hash && c.phash && hamming(hash, c.phash) <= SAME_IMAGE) || (headlineNorm.length > 12 && c.headline_norm === headlineNorm && (!hash || !c.phash || hamming(hash, c.phash) <= 20)));
    if (dup) {
      await insertVariation(pool, dup.id, ad, stored, hash);
      await refreshAd(pool, dup.id);
      return "merged";
    }
  }

  const r = await pool.query<{ id: string }>(
    `INSERT INTO creative_ads (id, tenant_id, brand_id, advertiser, headline, headline_norm, body, cta, landing_url, media, phash, platforms, sources, countries,
                               first_seen, last_seen, is_active, metrics, status, reject_reason, search_text)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, ARRAY[$13]::text[], $14, $15::date, $16::date, $17, $18::jsonb, $19, $20, $21)
     RETURNING id`,
    [
      adKey, tenantId, ad.brandId ?? null, ad.advertiser.slice(0, 200), ad.headline.slice(0, 500), headlineNorm, ad.body.slice(0, 5000), ad.cta ?? null, ad.landingUrl ?? null,
      JSON.stringify(stored), hash, ad.platforms, ad.source, ad.countries ?? [], iso(ad.firstSeen), iso(ad.lastSeen), ad.isActive ?? null, JSON.stringify(ad.metrics ?? {}),
      pre.blocked ? "rejected" : "new", pre.blocked ? `text names ${pre.blocked}, no clothing words (free pre-check)` : null,
      `${ad.advertiser} ${ad.headline} ${ad.body}`.slice(0, 6000),
    ],
  );
  await insertVariation(pool, r.rows[0].id, ad, stored, hash);
  await refreshAd(pool, r.rows[0].id);
  return pre.blocked ? "preRejected" : "new";
}

async function insertVariation(pool: Pool, adId: string, ad: NormalizedAd, media: unknown[], hash: string | null) {
  await pool.query(
    `INSERT INTO creative_ad_variations (ad_id, source, external_id, platform, source_url, headline, body, media, phash, raw, first_seen, last_seen, is_active)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::date, $12::date, $13)
     ON CONFLICT (source, external_id) DO NOTHING`,
    [adId, ad.source, ad.externalId, ad.platforms.join(","), ad.sourceUrl ?? null, ad.headline.slice(0, 500), ad.body.slice(0, 5000), JSON.stringify(media), hash, JSON.stringify(ad.raw ?? null).slice(0, 200_000), iso(ad.firstSeen), iso(ad.lastSeen), ad.isActive ?? null],
  );
}

/** Roll the variations up into the ad: dates, active, platforms, sources, count, winner score. */
export async function refreshAd(pool: Pool, adId: string): Promise<void> {
  const r = await pool.query<{ first: Date | null; last: Date | null; active: boolean | null; n: number; platforms: string[]; sources: string[] }>(
    `SELECT MIN(first_seen) AS first, MAX(last_seen) AS last, bool_or(is_active) AS active, COUNT(*)::int AS n,
            ARRAY(SELECT DISTINCT unnest(string_to_array(string_agg(platform, ','), ',')) ) AS platforms,
            ARRAY_AGG(DISTINCT source) AS sources
       FROM creative_ad_variations WHERE ad_id = $1::uuid`,
    [adId],
  );
  const v = r.rows[0];
  if (!v) return;
  const platforms = (v.platforms ?? []).filter(Boolean);
  const score = winnerScore({ daysRunning: daysRunning(v.first, v.last, v.active), variations: v.n, platforms: platforms.length, active: v.active });
  await pool.query(
    `UPDATE creative_ads SET first_seen = $2, last_seen = $3, is_active = $4, variation_count = $5, platforms = $6, sources = $7, winner_score = $8, updated_at = now() WHERE id = $1::uuid`,
    [adId, v.first, v.last, v.active, v.n, platforms, v.sources ?? [], score],
  );
}

export async function startRun(pool: Pool, tenantId: string, source: string, brandId: string | null): Promise<string> {
  const r = await pool.query<{ id: string }>(`INSERT INTO creative_source_runs (tenant_id, source, brand_id) VALUES ($1::uuid, $2, $3::uuid) RETURNING id`, [tenantId, source, brandId]);
  return r.rows[0].id;
}
export async function finishRun(pool: Pool, runId: string, counts: RunCounts, error: string | null, log: string[]) {
  await pool.query(
    `UPDATE creative_source_runs SET status = $2, counts = $3::jsonb, error = $4, rejections = $5::jsonb, finished_at = now() WHERE id = $1::uuid`,
    [runId, error ? "failed" : "done", JSON.stringify(counts), error, JSON.stringify(log.slice(-60))],
  );
}
