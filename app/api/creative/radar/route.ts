/**
 * GET  /api/creative/radar?view=ads|stats|collections|brands|runs|boards & filters — the Radar
 *      library (private research: admin only, never a public link).
 * POST /api/creative/radar {action} — refresh (one brand or everything), import (paste a URL),
 *      review (keep / reject from the Review queue), bookmark, board, brand (add / approve /
 *      reject / disable / ids), tag now.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { withActivity } from "@/lib/server/activity-log";
import { guard, fail, body, kick } from "@/lib/server/creative/http";
import { listAds, patternCollections, radarStats, type RadarFilters } from "@/lib/server/creative/radar/query";
import { enqueue } from "@/lib/server/creative/jobs";
import { ensureSeedBrands, queueTagging } from "@/lib/server/creative/radar/run";
import { ingestAd } from "@/lib/server/creative/radar/ingest";
import { manualFromUrl, SOURCE_DEFAULTS } from "@/lib/server/creative/radar/sources";
import { PlainError } from "@/lib/server/creative/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const list = (v: string | null) => (v ? v.split(",").map((x) => x.trim()).filter(Boolean) : undefined);
const numOr = (v: string | null) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
const oneOf = <T extends string>(v: string | null, allowed: readonly T[]): T | undefined => (v && (allowed as readonly string[]).includes(v) ? (v as T) : undefined);

export async function GET(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const u = new URL(req.url).searchParams;
  const tid = g.session.tid;
  try {
    switch (u.get("view") ?? "ads") {
      case "stats":
        return NextResponse.json(await radarStats(g.pool, tid));
      case "collections":
        return NextResponse.json({ collections: await patternCollections(g.pool, tid) });
      case "brands": {
        await ensureSeedBrands(g.pool, tid);
        const r = await g.pool.query(
          `SELECT b.id::text, b.name, b.lane, b.status, b.prior, b.meta_page_ids, b.handles, b.found_by, b.last_refreshed_at,
                  (SELECT COUNT(*)::int FROM creative_ads a WHERE a.brand_id = b.id AND a.status = 'kept') AS kept
             FROM creative_ad_brands b WHERE b.tenant_id = $1::uuid ORDER BY (b.status = 'pending') DESC, b.lane NULLS LAST, b.name`,
          [tid],
        );
        return NextResponse.json({ brands: r.rows });
      }
      case "runs": {
        const r = await g.pool.query(
          `SELECT r.id::text, r.source, r.status, r.counts, r.rejections, r.error, r.started_at, r.finished_at, b.name AS brand
             FROM creative_source_runs r LEFT JOIN creative_ad_brands b ON b.id = r.brand_id WHERE r.tenant_id = $1::uuid ORDER BY r.started_at DESC LIMIT 200`,
          [tid],
        );
        const totals = await g.pool.query(
          `SELECT source, COUNT(*)::int AS runs, COALESCE(SUM((counts->>'discovered')::int), 0)::int AS discovered, COALESCE(SUM((counts->>'new')::int), 0)::int AS new,
                  COALESCE(SUM((counts->>'merged')::int), 0)::int AS merged, COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
             FROM creative_source_runs WHERE tenant_id = $1::uuid GROUP BY source`,
          [tid],
        );
        return NextResponse.json({ runs: r.rows, totals: totals.rows, sources: SOURCE_DEFAULTS });
      }
      case "boards": {
        const r = await g.pool.query(`SELECT b.id::text, b.name, (SELECT COUNT(*)::int FROM creative_board_items i WHERE i.board_id = b.id) AS n FROM creative_boards b WHERE b.tenant_id = $1::uuid ORDER BY b.created_at`, [tid]);
        return NextResponse.json({ boards: r.rows });
      }
      default: {
        const f: RadarFilters = {
          tab: oneOf(u.get("tab"), ["all", "static", "video", "ugc", "animated", "bookmarks"] as const) ?? "all",
          q: u.get("q") ?? undefined,
          sort: oneOf(u.get("sort"), ["fresh", "recommended", "newest", "longest"] as const) ?? "fresh",
          category: u.get("category") ?? undefined,
          mediaTypes: list(u.get("media")),
          patterns: list(u.get("patterns")),
          lanes: list(u.get("lanes")),
          genders: list(u.get("genders")),
          platforms: list(u.get("platforms")),
          sources: list(u.get("sources")),
          countries: list(u.get("countries")),
          seasons: list(u.get("seasons")),
          brands: list(u.get("brands"))?.filter((b) => /^[0-9a-f-]{36}$/.test(b)),
          daysMin: numOr(u.get("daysMin")),
          daysMax: numOr(u.get("daysMax")),
          hasOffer: u.get("hasOffer") === "1",
          aspect: oneOf(u.get("aspect"), ["vertical", "square", "horizontal"] as const),
          status: oneOf(u.get("status"), ["kept", "review", "rejected"] as const) ?? "kept",
          limit: numOr(u.get("limit")) ?? 60,
          offset: numOr(u.get("offset")) ?? 0,
        };
        return NextResponse.json(await listAds(g.pool, tid, f));
      }
    }
  } catch (e) {
    return fail(e);
  }
}

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("refresh"), brandId: z.string().uuid().nullable().optional() }),
  z.object({ action: z.literal("import"), url: z.string().url().max(1000) }),
  z.object({ action: z.literal("review"), adId: z.string().uuid(), status: z.enum(["kept", "rejected"]) }),
  z.object({ action: z.literal("bookmark"), adId: z.string().uuid(), boardId: z.string().uuid().nullable().optional(), on: z.boolean() }),
  z.object({ action: z.literal("board"), name: z.string().min(1).max(60) }),
  z.object({ action: z.literal("brand_add"), name: z.string().min(1).max(120), lane: z.string().max(40).nullable().optional(), prior: z.enum(["apparel", "footwear", "mixed", "unknown"]).default("apparel") }),
  z.object({ action: z.literal("brand_status"), brandId: z.string().uuid(), status: z.enum(["active", "rejected", "disabled"]) }),
  z.object({ action: z.literal("brand_ids"), brandId: z.string().uuid(), metaPageIds: z.array(z.string().regex(/^\d+$/)).max(10), google: z.string().regex(/^AR\d+$/).nullable().optional() }),
  z.object({ action: z.literal("tag_now") }),
]);

async function POST_handler(req: Request) {
  const g = await guard(req);
  if ("error" in g) return g.error;
  const tid = g.session.tid;
  const by = g.session.email ?? null;
  try {
    const a = await body(req, schema);
    switch (a.action) {
      case "refresh":
        await enqueue(g.pool, tid, "radar_nightly", { brandId: a.brandId ?? undefined }, { requestedBy: by, progress: a.brandId ? "Refreshing this brand" : "Refreshing every brand" });
        break;
      case "import": {
        const ad = await manualFromUrl(a.url);
        if (!ad.media.length) throw new PlainError("No picture or video found at that link. Download the ad and upload the file instead.");
        const res = await ingestAd(g.pool, tid, ad);
        if (res === "new") await queueTagging(g.pool, tid, by);
        kick(g.pool, tid);
        return NextResponse.json({ result: res });
      }
      case "review":
        await g.pool.query(`UPDATE creative_ads SET status = $3, reject_reason = CASE WHEN $3 = 'rejected' THEN 'rejected by the owner' ELSE NULL END, updated_at = now() WHERE id = $1::uuid AND tenant_id = $2::uuid`, [a.adId, tid, a.status]);
        return NextResponse.json({ ok: true });
      case "board": {
        const r = await g.pool.query<{ id: string }>(`INSERT INTO creative_boards (tenant_id, name) VALUES ($1::uuid, $2) RETURNING id::text`, [tid, a.name]);
        return NextResponse.json({ boardId: r.rows[0].id });
      }
      case "bookmark": {
        let boardId = a.boardId;
        if (!boardId) {
          const b = await g.pool.query<{ id: string }>(`SELECT id::text FROM creative_boards WHERE tenant_id = $1::uuid ORDER BY created_at LIMIT 1`, [tid]);
          boardId = b.rows[0]?.id ?? (await g.pool.query<{ id: string }>(`INSERT INTO creative_boards (tenant_id, name) VALUES ($1::uuid, 'Saved') RETURNING id::text`, [tid])).rows[0].id;
        }
        if (a.on) await g.pool.query(`INSERT INTO creative_board_items (board_id, ad_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT DO NOTHING`, [boardId, a.adId]);
        else await g.pool.query(`DELETE FROM creative_board_items WHERE ad_id = $1::uuid AND board_id IN (SELECT id FROM creative_boards WHERE tenant_id = $2::uuid)`, [a.adId, tid]);
        return NextResponse.json({ ok: true });
      }
      case "brand_add":
        await g.pool.query(`INSERT INTO creative_ad_brands (tenant_id, name, lane, prior, found_by) VALUES ($1::uuid, $2, $3, $4, 'owner') ON CONFLICT DO NOTHING`, [tid, a.name, a.lane ?? null, a.prior]);
        return NextResponse.json({ ok: true });
      case "brand_status":
        await g.pool.query(`UPDATE creative_ad_brands SET status = $3, prior = CASE WHEN $3 = 'active' AND prior = 'unknown' THEN 'apparel' ELSE prior END WHERE id = $1::uuid AND tenant_id = $2::uuid`, [a.brandId, tid, a.status]);
        return NextResponse.json({ ok: true });
      case "brand_ids":
        await g.pool.query(`UPDATE creative_ad_brands SET meta_page_ids = $3, handles = handles || $4::jsonb WHERE id = $1::uuid AND tenant_id = $2::uuid`, [a.brandId, tid, a.metaPageIds, JSON.stringify(a.google ? { google: a.google } : {})]);
        return NextResponse.json({ ok: true });
      case "tag_now":
        await queueTagging(g.pool, tid, by);
        await g.pool.query(`UPDATE creative_jobs SET run_after = now() WHERE tenant_id = $1::uuid AND kind = 'radar_tag' AND status IN ('queued','waiting')`, [tid]);
        break;
    }
    kick(g.pool, tid);
    return NextResponse.json({ ok: true }, { status: 202 });
  } catch (e) {
    return fail(e);
  }
}

export const POST = withActivity("creative/radar", POST_handler);
