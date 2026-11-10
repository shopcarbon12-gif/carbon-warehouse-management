/**
 * CarbonWMS Creative — tests with NO paid AI calls (no OpenAI, no fal.ai).
 *
 *   CREATIVE_TEST_DB=postgres://postgres:pw@127.0.0.1:55433/postgres \
 *   CREATIVE_STORAGE_DIR=/tmp/creative-test SESSION_SECRET=test \
 *   [CREATIVE_TEST_RENDER=1 HYPERFRAMES_BIN=<node22 hyperframes wrapper>] \
 *   npx tsx scripts/test-creative.ts
 *
 * Uses a throwaway Postgres (applies 0161 + small stubs of the tables it joins), files in a local
 * folder, and a tiny local HTTP server standing in for ad media.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import sharp from "sharp";

const DB = process.env.CREATIVE_TEST_DB;
if (!DB) throw new Error("set CREATIVE_TEST_DB to a throwaway Postgres");
if (!process.env.CREATIVE_STORAGE_DIR) throw new Error("set CREATIVE_STORAGE_DIR (files stay local, never R2)");

let passed = 0;
const failed: string[] = [];
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed.push(name);
    console.log(`  ✗ ${name}\n    ${(e as Error).stack?.split("\n").slice(0, 4).join("\n    ")}`);
  }
}

const TID = "11111111-1111-1111-1111-111111111111";

async function setupDb(pool: Pool) {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await pool.query(`
    CREATE TABLE models (model_id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, gender text NOT NULL, ref_image_urls jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE model_profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), studio_model_name text, height text, size text);
    CREATE TABLE marketing_posts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, campaign text, source_ref text, title text, format text, caption text, hashtags text[], scheduled_at timestamptz, status text DEFAULT 'draft', created_by text, note text);
    CREATE TABLE marketing_post_targets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), post_id uuid, provider text, status text DEFAULT 'pending', published_at timestamptz, metrics jsonb, UNIQUE (post_id, provider));
    CREATE TABLE email_orders_seen (source text, order_id text, tenant_id uuid, email text, total numeric, processed_at timestamptz, PRIMARY KEY (source, order_id));
  `);
  await pool.query(readFileSync(path.join(process.cwd(), "scripts/migrations/0161_creative_engine.sql"), "utf8"));
  await pool.query(readFileSync(path.join(process.cwd(), "scripts/migrations/0161_creative_engine.sql"), "utf8")); // idempotent
}

/** A local "CDN" for ad media. */
async function mediaServer(files: Record<string, { body: Buffer; type: string }>): Promise<{ base: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    const f = files[req.url ?? ""];
    if (!f) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": f.type, "Content-Length": f.body.length }).end(f.body);
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

async function picture(seed: number, w = 800, h = 1000): Promise<Buffer> {
  // Distinct, structured pictures (stripes + blocks), so pHash tells them apart.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="hsl(${(seed * 67) % 360},40%,${20 + (seed % 5) * 10}%)"/>
    ${Array.from({ length: 6 }, (_, i) => `<rect x="${((seed * 37 + i * 131) % w)}" y="${(i * h) / 6}" width="${120 + ((seed * 13 + i * 29) % 300)}" height="${h / 7}" fill="hsl(${(seed * 31 + i * 50) % 360},70%,${30 + i * 8}%)"/>`).join("")}
    <circle cx="${(seed * 97) % w}" cy="${(seed * 53) % h}" r="${80 + (seed % 7) * 20}" fill="#fff" opacity=".8"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

async function main() {
  const pool = new Pool({ connectionString: DB, max: 3 });
  await setupDb(pool);
  console.log("migration 0161 applied twice ✓");

  const { decide, textPreCheck } = await import("../lib/server/creative/radar/classify");
  const { winnerScore, daysRunning } = await import("../lib/server/creative/radar/score");
  const { phash, hamming, beatsFromPcm } = await import("../lib/server/creative/media");
  const { ingestAd } = await import("../lib/server/creative/radar/ingest");
  const { listAds, radarStats, patternCollections } = await import("../lib/server/creative/radar/query");
  const { enqueue, tick } = await import("../lib/server/creative/jobs");
  const { spendGate, recordSpend, PlainError, getBrand, presetOf } = await import("../lib/server/creative/config");
  const { autoCast } = await import("../lib/server/creative/casting");
  const { buildEditPlan, composeHyperFrames, finishingArgs } = await import("../lib/server/creative/editor");
  const { captionCards } = await import("../lib/server/creative/ugc");
  const { HANDLERS, SCHEDULED_KINDS } = await import("../lib/server/creative/handlers");
  const { signedUrl, verifySigned } = await import("../lib/server/creative/storage");
  const { buildVideoInput } = await import("../lib/server/creative/engines");
  const { ensureRecipes, listRecipes } = await import("../lib/server/creative/recipes");

  console.log("\nCategory filter (spec §4.1)");
  const opt = { bags: false, hats: false, belts: false };
  const A = (product_category: string, isC: boolean, adv: boolean, confidence: number) => ({ product_category, is_clothing_or_footwear: isC, advertised_product_is_clothing_or_footwear: adv, confidence });
  const cases: [string, ReturnType<typeof A>, string | null, "kept" | "review" | "rejected"][] = [
    ["denim kept", A("denim", true, true, 0.9), "apparel", "kept"],
    ["sneakers kept", A("footwear", true, true, 0.82), "footwear", "kept"],
    ["jewelry blocked even if confident", A("jewelry", false, false, 0.99), "apparel", "rejected"],
    ["eyewear blocked", A("eyewear", false, false, 0.95), null, "rejected"],
    ["watches blocked", A("watches", false, false, 0.97), null, "rejected"],
    ["model in jeans selling sunglasses → rejected (mixed ad)", A("eyewear", true, false, 0.9), "apparel", "rejected"],
    ["fragrance blocked", A("fragrance", false, false, 0.9), null, "rejected"],
    ["hats off by default", A("hats", true, true, 0.9), "apparel", "rejected"],
    ["unsure dress → review", A("dresses", true, true, 0.6), null, "review"],
    ["low confidence → rejected", A("tops", true, true, 0.3), null, "rejected"],
  ];
  for (const [name, a, prior, want] of cases) await t(name, () => assert.equal(decide(a, { prior, landing: null, optional: opt }).status, want));
  await t("hats kept when the owner switches them on", () => assert.equal(decide(A("hats", true, true, 0.9), { prior: "apparel", landing: null, optional: { ...opt, hats: true } }).status, "kept"));
  await t("landing page with blocked schema → not kept (review or reject)", () => assert.notEqual(decide(A("tops", true, true, 0.8), { prior: null, landing: { apparel: false, blocked: "jewelry", text: "" }, optional: opt }).status, "kept"));
  await t("free pre-check: jewelry text, no clothing words → blocked", () => assert.equal(textPreCheck("New gold necklace and diamond earrings, 30% off").blocked, "jewelry"));
  await t("free pre-check: sunglasses text → blocked", () => assert.equal(textPreCheck("Polarized sunglasses for summer").blocked, "eyewear"));
  await t("free pre-check: jeans + rings mention → not blocked (clothing words win)", () => assert.equal(textPreCheck("Baggy jeans that fit like a ring of fire").blocked, null));

  console.log("\nScore + fingerprints");
  await t("winner score: long-running, many variations beats a new single ad", () => {
    const old = winnerScore({ daysRunning: 120, variations: 12, platforms: 3, active: true })!;
    const fresh = winnerScore({ daysRunning: 2, variations: 1, platforms: 1, active: true })!;
    assert.ok(old > 80 && fresh < 25, `${old} vs ${fresh}`);
  });
  await t("winner score is null with no signals (shown as —)", () => assert.equal(winnerScore({ daysRunning: null, variations: 1, platforms: 0, active: null }), null));
  await t("days running uses today for active ads", () => assert.ok((daysRunning(new Date(Date.now() - 10 * 86400000), null, true) ?? 0) >= 10));
  const p1 = await picture(1), p2 = await picture(2);
  const p1small = await sharp(p1).resize(400).jpeg({ quality: 60 }).toBuffer();
  await t("pHash: same picture resized + recompressed is a near-match", async () => assert.ok(hamming(await phash(p1), await phash(p1small)) <= 10));
  await t("pHash: different pictures are far apart", async () => assert.ok(hamming(await phash(p1), await phash(p2)) > 10));

  console.log("\nIngest + dedupe (local media server, local storage)");
  const pics: Record<string, { body: Buffer; type: string }> = {};
  for (let i = 1; i <= 8; i++) pics[`/a${i}.jpg`] = { body: await picture(i * 3), type: "image/jpeg" };
  pics["/a1-small.jpg"] = { body: await sharp(pics["/a1.jpg"].body).resize(500).jpeg({ quality: 55 }).toBuffer(), type: "image/jpeg" };
  const srv = await mediaServer(pics);
  const base = (over: Partial<Parameters<typeof ingestAd>[2]>) => ({
    source: "meta_library", externalId: "x", platforms: ["facebook"], advertiser: "Kith", headline: "", body: "", media: [], firstSeen: new Date(Date.now() - 40 * 86400000).toISOString(), lastSeen: new Date().toISOString(), isActive: true, ...over,
  });
  const r1 = await ingestAd(pool, TID, base({ externalId: "m1", headline: "The new denim drop", body: "Raw selvedge jeans", media: [{ kind: "image", url: `${srv.base}/a1.jpg` }] }));
  const r2 = await ingestAd(pool, TID, base({ externalId: "m2", platforms: ["instagram"], headline: "New denim drop", body: "Raw selvedge jeans", media: [{ kind: "image", url: `${srv.base}/a1-small.jpg` }] }));
  const r3 = await ingestAd(pool, TID, base({ externalId: "m1", headline: "The new denim drop", media: [{ kind: "image", url: `${srv.base}/a1.jpg` }] }));
  const r4 = await ingestAd(pool, TID, base({ source: "tiktok_top", externalId: "t1", platforms: ["tiktok"], advertiser: "Stüssy", headline: "Hoodie season", media: [{ kind: "image", url: `${srv.base}/a2.jpg` }] }));
  const r5 = await ingestAd(pool, TID, base({ externalId: "j1", advertiser: "Some Jeweler", headline: "Gold necklace sale", body: "Diamond earrings and bracelets", media: [{ kind: "image", url: `${srv.base}/a3.jpg` }] }));
  await t("first sighting → new", () => assert.equal(r1, "new"));
  await t("same picture (smaller, recompressed) on another platform → merged, not a new ad", () => assert.equal(r2, "merged"));
  await t("same source id again → already known", () => assert.equal(r3, "seen"));
  await t("other brand → new", () => assert.equal(r4, "new"));
  await t("jewelry ad → rejected by the free pre-check (no AI cost)", () => assert.equal(r5, "preRejected"));
  const kith = (await pool.query(`SELECT variation_count, platforms, sources, winner_score, media FROM creative_ads WHERE advertiser = 'Kith'`)).rows;
  await t("merged ad: 2 variations, 2 platforms", () => {
    assert.equal(kith.length, 1);
    assert.equal(kith[0].variation_count, 2);
    assert.deepEqual([...kith[0].platforms].sort(), ["facebook", "instagram"]);
  });
  await t("media copied to storage (never hotlinked)", () => assert.ok(existsSync(path.join(process.env.CREATIVE_STORAGE_DIR!, kith[0].media[0].storage_path))));
  for (let i = 4; i <= 8; i++) await ingestAd(pool, TID, base({ externalId: `b${i}`, advertiser: i % 2 ? "Represent" : "Diesel", headline: `Ad ${i} jacket`, body: i === 6 ? "20% off this weekend" : "", media: [{ kind: "image", url: `${srv.base}/a${i}.jpg` }], platforms: i % 2 ? ["facebook", "instagram"] : ["facebook"] }));
  srv.close();

  console.log("\nRadar filters (spec §5) — every filter changes the counts");
  // Tag like the batch would, by hand (no AI).
  const tagRows = await pool.query<{ id: string; advertiser: string; headline: string }>(`SELECT id::text, advertiser, headline FROM creative_ads WHERE status = 'new' ORDER BY created_at`);
  const lanes = ["denim", "streetwear", "streetwear", "luxury", "denim", "evening_going_out", "streetwear"];
  const types = ["static", "video", "static", "ugc", "static", "animated", "video"];
  for (const [i, r] of tagRows.rows.entries()) {
    await pool.query(
      `UPDATE creative_ads SET status = $2, media_type = $3, tags = $4::jsonb, category = $5::jsonb, search_text = search_text || ' ' || $6 WHERE id = $1::uuid`,
      [r.id, i === 6 ? "review" : "kept", types[i], JSON.stringify({ style_lane: lanes[i], creative_pattern: i % 2 ? ["price_anchor"] : ["material_detail_as_proof"], gender: i % 3 ? "men" : "women", season_event: i === 2 ? "bfcm" : "evergreen", offer: r.headline.includes("6") ? "20% off" : null, hook_text: `hook ${i}`, structure_summary: "macro then reveal" }), JSON.stringify({ product_category: i % 2 ? "tops" : "denim" }), i === 3 ? "fabric macro reveal" : ""],
    );
  }
  const n = async (f: Parameters<typeof listAds>[2]) => (await listAds(pool, TID, f)).total;
  const all = await n({});
  await t(`all kept = ${all}`, () => assert.equal(all, 6));
  await t("tab: video", async () => assert.equal(await n({ tab: "video" }), 1));
  await t("tab: static", async () => assert.equal(await n({ tab: "static" }), 3));
  await t("pattern filter", async () => assert.ok((await n({ patterns: ["price_anchor"] })) > 0 && (await n({ patterns: ["price_anchor"] })) < all));
  await t("lane filter", async () => assert.equal(await n({ lanes: ["denim"] }), 2));
  await t("gender filter", async () => assert.ok((await n({ genders: ["women"] })) < all));
  await t("platform filter", async () => assert.ok((await n({ platforms: ["tiktok"] })) === 1));
  await t("source filter", async () => assert.equal(await n({ sources: ["tiktok_top"] }), 1));
  await t("season filter", async () => assert.equal(await n({ seasons: ["bfcm"] }), 1));
  await t("category dropdown", async () => assert.ok((await n({ category: "tops" })) < all));
  await t("search (brand / hook / tags)", async () => assert.ok((await n({ q: "Represent" })) >= 1 && (await n({ q: "zzzz-none" })) === 0));
  await t("days running range", async () => assert.equal(await n({ daysMin: 1000 }), 0));
  await t("has offer", async () => assert.ok((await n({ hasOffer: true })) < all));
  await t("review queue", async () => assert.equal(await n({ status: "review" }), 1));
  await t("sorts all return the same set", async () => {
    for (const sort of ["fresh", "recommended", "newest", "longest"] as const) assert.equal(await n({ sort }), all);
  });
  const stats = await radarStats(pool, TID);
  await t("stats: real counts (kept / review / rejected)", () => {
    assert.equal(stats.kept, 6);
    assert.equal(stats.review, 1);
    assert.equal(stats.rejected, 1);
  });
  await t("zero jewelry / eyewear / watches kept", async () => {
    const bad = await pool.query(`SELECT COUNT(*)::int AS n FROM creative_ads WHERE status = 'kept' AND (category->>'product_category' IN ('jewelry','eyewear','watches') OR search_text ~* '(necklace|earring|sunglass|watch)')`);
    assert.equal(bad.rows[0].n, 0);
  });
  await t("pattern collections", async () => assert.ok((await patternCollections(pool, TID)).length >= 2));

  console.log("\nJobs + spend caps");
  await t("caps: a step over the daily cap pauses (plain English)", async () => {
    await recordSpend(pool, TID, { provider: "fal", what: "test", cost: 14.5 });
    await assert.rejects(spendGate(pool, TID, "fal", 1), (e: Error) => e instanceof PlainError && e.message.startsWith("Paused:"));
    await spendGate(pool, TID, "openai", 1);
  });
  await t("jobs: waiting → done, failures get a plain message, cap → paused", async () => {
    let calls = 0;
    const handlers = {
      two_step: async () => (++calls === 1 ? { status: "waiting" as const, afterSeconds: 0, progress: "half" } : { status: "done" as const, progress: "ok" }),
      boom: async () => {
        throw new PlainError("That product is gone.");
      },
      capped: async () => {
        await spendGate(pool, TID, "fal", 5);
        return { status: "done" as const };
      },
    };
    const a = await enqueue(pool, TID, "two_step", {});
    const b = await enqueue(pool, TID, "boom", {});
    const c = await enqueue(pool, TID, "capped", {});
    await tick(pool, TID, handlers, 5000);
    await tick(pool, TID, handlers, 5000);
    const s = Object.fromEntries((await pool.query(`SELECT id::text, status, error FROM creative_jobs WHERE id = ANY($1::uuid[])`, [[a, b, c]])).rows.map((r) => [r.id, r]));
    assert.equal(s[a].status, "done");
    assert.equal(s[b].status, "failed");
    assert.equal(s[b].error, "That product is gone.");
    assert.equal(s[c].status, "paused");
  });

  console.log("\nCasting variety rule (spec §7.1)");
  for (const [id, name, g] of [["m1", "Elena", "female"], ["m2", "Zara", "female"], ["m3", "Daniela", "female"], ["m4", "Nico", "male"], ["m5", "Jaylen", "male"]])
    await pool.query(`INSERT INTO models (model_id, user_id, name, gender, ref_image_urls) VALUES ($1, 'u', $2, $3, '["https://x/a.png","https://x/b.png"]')`, [id, name, g]);
  for (let i = 0; i < 3; i++) await pool.query(`INSERT INTO creative_projects (tenant_id, kind, products, cast_ids) VALUES ($1::uuid, $2, '{p}', $3)`, [TID, i === 2 ? "ugc" : "video", i < 2 ? ["m1"] : ["m2"]]);
  await t("a model in 2 of the last 10 ads is skipped", async () => {
    for (let k = 0; k < 20; k++) assert.notEqual((await autoCast(pool, TID, { lane: null, gender: "women", count: 1, kind: "video" }))[0].id, "m1");
  });
  await t("…unless pinned (then they are allowed again)", async () => {
    await pool.query(`INSERT INTO creative_model_meta (tenant_id, model_id, pinned) VALUES ($1::uuid, 'm1', true)`, [TID]);
    assert.equal((await autoCast(pool, TID, { lane: null, gender: "women", count: 1, kind: "video", exclude: ["m2", "m3"] }))[0].id, "m1");
  });
  await t("UGC never repeats the last UGC creator", async () => {
    for (let k = 0; k < 20; k++) assert.notEqual((await autoCast(pool, TID, { lane: null, gender: "women", count: 1, kind: "ugc" }))[0].id, "m2");
  });
  await t("crew of 2 for unisex mixes gender", async () => {
    const c = await autoCast(pool, TID, { lane: null, gender: "unisex", count: 2, kind: "video" });
    assert.equal(new Set(c.map((m) => m.gender)).size, 2);
  });

  console.log("\nBeats + edit plan (spec §7.4)");
  const sr = 11025, bpm = 124, secs = 24;
  const pcm = new Float32Array(sr * secs);
  for (let b = 0; b * (60 / bpm) < secs; b++) {
    const at = Math.round(b * (60 / bpm) * sr);
    const loud = b * (60 / bpm) > 12 ? 1 : 0.35; // the drop at 12 s
    for (let k = 0; k < 600 && at + k < pcm.length; k++) pcm[at + k] = loud * Math.exp(-k / 120) * Math.sin(k / 3);
  }
  const beats = beatsFromPcm(pcm, sr);
  await t(`tempo found: ${beats.bpm} BPM (want 124 ± 2)`, () => assert.ok(Math.abs(beats.bpm - 124) <= 2));
  await t(`drop found near 12 s (${beats.drop?.toFixed(2)})`, () => assert.ok(beats.drop != null && Math.abs(beats.drop - 12) < 1.2));
  const brand = await getBrand(pool, TID);
  const shot = (idx: number, d: number, over: Record<string, unknown> = {}) => ({
    idx, subject_action: `shot ${idx}`, camera_move: "static" as const, lens: "35mm" as const, lighting: "neon rim", location: "garage", duration_s: d, transition_in: idx % 2 ? "flash_frame" : "whip_pan",
    garment_must_show: "wash", cast: [], products: [], text_overlay: null as string | null, is_end_card: false, is_static_frame: false, still_prompt: "", motion_prompt: "", sfx: ["whoosh"], ...over,
  });
  const shots = [shot(0, 1.4, { text_overlay: "STOP SCROLLING" }), shot(1, 1.9), shot(2, 2.1, { text_overlay: "Raw Denim $89" }), shot(3, 1.7), shot(4, 1.6, { is_end_card: true })];
  const plan = buildEditPlan({
    shots, media: { 0: { kind: "image", asset: "s0.jpg" }, 1: { kind: "image", asset: "s1.jpg" }, 2: { kind: "image", asset: "s2.jpg" }, 3: { kind: "image", asset: "s3.jpg" } },
    aspect: "9:16", brand, preset: presetOf(brand, "street"), music: { asset: "music.wav", beats: beats.beats, bpm: beats.bpm, drop: beats.drop, duration: secs }, sfx: { whoosh: "whoosh.wav" }, assets: {}, logoAsset: null,
  });
  const beatSet = beats.beats.map((b) => b - plan.music!.mediaStart);
  await t("every cut lands on a beat (±40 ms)", () => {
    for (const s of plan.segments.slice(1)) assert.ok(beatSet.some((b) => Math.abs(b - s.start) < 0.04), `cut at ${s.start}`);
  });
  await t("the hero reveal (price shot) starts on the drop", () => {
    const hero = plan.segments.find((s) => s.text?.text.includes("$"))!;
    assert.ok(Math.abs(hero.start + plan.music!.mediaStart - beats.drop!) < 0.6, `${hero.start + plan.music!.mediaStart} vs ${beats.drop}`);
  });
  await t("text inside the Reels safe zone; end card last", () => {
    assert.ok(plan.safe.bottom >= 1920 * 0.18 && plan.safe.top >= 1920 * 0.12);
    assert.ok(Math.abs(plan.endCard.start + plan.endCard.dur - plan.duration) < 0.01);
  });
  await t("finishing pass: grade + grain + −14 LUFS", () => {
    const a = finishingArgs(plan, "in.mp4", "out.mp4", { hasAudio: true }).join(" ");
    assert.match(a, /eq=contrast=1\.18/);
    assert.match(a, /noise=alls=/);
    assert.match(a, /loudnorm=I=-14/);
  });
  const html = composeHyperFrames(plan);
  await t("HyperFrames composition: root, timeline, clips, audio ids", () => {
    assert.match(html, /data-composition-id="main"/);
    assert.match(html, /window\.__timelines\["main"\] = tl/);
    assert.equal((html.match(/class="clip seg"/g) ?? []).length, 4);
    assert.match(html, /<audio id="music"/);
    assert.match(html, /<audio id="fx0"/);
    assert.doesNotMatch(html, /filter:\s*(blur|contrast)/); // no CSS filters on footage (grade is ffmpeg)
  });

  console.log("\nUGC captions, engines, links, recipes, the no-autopilot rule");
  await t("UGC captions are timed in order, ≤ 4 words each", () => {
    const c = captionCards({ persona: "x", hook: "Okay this fit is crazy", lines: [{ say: "The wash on these jeans is so clean up close", action: "", seconds: 3, fact_used: null }, { say: "Relaxed fit through the leg", action: "", seconds: 2, fact_used: null }, { say: "Back pockets too", action: "", seconds: 2, fact_used: null }], cta: "shopcarbon.com", banned_check: { invented_reviews: false, invented_stats: false, claims_to_be_customer: false } });
    for (let i = 1; i < c.length; i++) assert.ok(c[i].at >= c[i - 1].at);
    assert.ok(c.every((x) => x.text.split(" ").length <= 4));
  });
  await t("Kling input: start_image_url + string duration", () => {
    const { input, seconds } = buildVideoInput({ engineId: "fal-ai/kling-video/v3/pro/image-to-video", prompt: "walk", imageUrl: "https://x/a.png", seconds: 4.4, aspect: "9:16", audio: false });
    assert.equal(input.start_image_url, "https://x/a.png");
    assert.equal(input.duration, "5");
    assert.equal(seconds, 5);
  });
  await t("Veo input: image_url + '6s' + 9:16", () => {
    const { input } = buildVideoInput({ engineId: "fal-ai/veo3.1/image-to-video", prompt: "talk", imageUrl: "https://x/a.png", seconds: 5, aspect: "9:16", audio: true });
    assert.equal(input.image_url, "https://x/a.png");
    assert.equal(input.duration, "6s");
    assert.equal(input.aspect_ratio, "9:16");
  });
  await t("Seedance reference mode: still first, identity refs after", () => {
    const { input } = buildVideoInput({ engineId: "bytedance/seedance-2.0/reference-to-video", prompt: "walk", imageUrl: "https://x/first.png", referenceUrls: ["https://x/face.png"], seconds: 5, aspect: "9:16", audio: false });
    assert.deepEqual(input.image_urls, ["https://x/first.png", "https://x/face.png"]);
    assert.match(String(input.prompt), /@Image1/);
  });
  await t("signed links: CARBON files yes, Radar media never, tampering fails", () => {
    const u = signedUrl("creative/projects/p/still-1.png");
    const tok = u.split("/f/")[1];
    assert.equal(verifySigned(tok), "creative/projects/p/still-1.png");
    assert.throws(() => signedUrl("creative/radar/x/0.jpg"));
    const [b, sig] = tok.replace(/\.png$/, "").split(".");
    assert.equal(verifySigned(`${b}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}.png`), null);
    assert.equal(verifySigned(`${tok}.extra`), null);
  });
  await t("15 seed recipes", async () => {
    await ensureRecipes(pool, TID);
    assert.equal((await listRecipes(pool, TID)).length, 15);
  });
  await t("no scheduled job makes pictures or video (spec §8)", () => {
    const gen = ["project_concepts", "concept_thumbs", "project_shots", "project_stills", "project_draft", "project_final", "twin_build", "campaign_pack"];
    for (const k of SCHEDULED_KINDS) assert.ok(!gen.includes(k));
    const worker = readFileSync(path.join(process.cwd(), "scripts/worker.ts"), "utf8");
    assert.doesNotMatch(worker.slice(worker.indexOf("maybeRunCreative")), /project_|twin_build|concept/);
    assert.ok(Object.keys(HANDLERS).length >= 15);
  });
  await t("Ideas makes exactly one LLM call per tap", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/server/creative/ideas.ts"), "utf8");
    assert.equal((src.match(/await json\(/g) ?? []).length, 1);
    assert.doesNotMatch(src, /generateImage|submitVideo|enqueue\(/);
  });

  console.log("\nStatics (text never AI-drawn)");
  const { composeStatic } = await import("../lib/server/creative/statics");
  const still = await picture(9, 1024, 1536);
  for (const size of ["4:5", "9:16"]) {
    await t(`static ${size}: right size, words drawn by Satori`, async () => {
      const out = await composeStatic(brand, still, size, { headline: "Raw denim", price: "$89", cta: "Shop now", template: "hook_top" });
      const m = await sharp(out).metadata();
      assert.equal(`${m.width}x${m.height}`, size === "4:5" ? "1080x1350" : "1080x1920");
      await writeFile(path.join(process.env.CREATIVE_STORAGE_DIR!, `static-${size.replace(":", "x")}.jpg`), out);
    });
  }

  if (process.env.CREATIVE_TEST_RENDER === "1") {
    console.log("\nReal render: HyperFrames (HTML → MP4) + finishing, on this machine (free)");
    const { HyperFramesEngine } = await import("../lib/server/creative/render-worker");
    const { FFMPEG, probe, run, keyframes } = await import("../lib/server/creative/media");
    const dir = await mkdtemp(path.join(os.tmpdir(), "creative-render-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "assets"), { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(path.join(dir, "assets", `s${i}.jpg`), await picture(20 + i * 5, 1080, 1920));
    // The click track as a WAV (the same 124 BPM signal the beat test used).
    const wav = path.join(dir, "assets", "music.wav");
    const raw = path.join(dir, "music.f32");
    await writeFile(raw, Buffer.from(pcm.buffer));
    await run(FFMPEG, ["-y", "-f", "f32le", "-ar", String(sr), "-ac", "1", "-i", raw, wav]);
    await run(FFMPEG, ["-y", "-f", "lavfi", "-i", "anoisesrc=d=0.4:c=pink:a=0.3", "-af", "afade=t=out:st=0.1:d=0.3", path.join(dir, "assets", "whoosh.wav")]);
    plan.textScale = 1;
    let out = "";
    await t("hyperframes render → MP4", async () => {
      out = await HyperFramesEngine.render(plan, dir);
      assert.ok(existsSync(out));
    });
    if (out) {
      const final = path.join(dir, "final.mp4");
      await t("finishing pass runs (grade, grain, loudness)", async () => {
        const m = await probe(out);
        await run(FFMPEG, finishingArgs(plan, out, final, { hasAudio: m.hasAudio }));
        const f = await probe(final);
        assert.ok(Math.abs(f.duration - plan.duration) < 0.4, `${f.duration} vs ${plan.duration}`);
        assert.equal(`${f.width}x${f.height}`, "1080x1920");
      });
      const dest = path.join(process.env.CREATIVE_STORAGE_DIR!, "render-test.mp4");
      await writeFile(dest, await readFile(existsSync(final) ? final : out));
      const k = await keyframes(await readFile(dest), 6, 360);
      for (const [i, f] of k.frames.entries()) await writeFile(path.join(process.env.CREATIVE_STORAGE_DIR!, `render-frame-${i}.jpg`), f);
      console.log(`    → ${dest} (${plan.duration}s, ${plan.segments.length} cuts on beats)`);
    }
    const { animatedHtml } = await import("../lib/server/creative/animated");
    const adir = await mkdtemp(path.join(os.tmpdir(), "creative-anim-"));
    await mkdir(path.join(adir, "assets"), { recursive: true });
    await writeFile(path.join(adir, "assets", "cut-0.png"), await sharp(await picture(41, 1024, 1536)).png().toBuffer());
    await writeFile(path.join(adir, "assets", "cut-1.png"), await sharp(await picture(47, 1024, 1536)).png().toBuffer());
    const anim = animatedHtml("price_drop", { title: "Raw Denim", price: "$69", compareAt: "$89", words: ["RAW", "DENIM"], images: ["cut-0.png", "cut-1.png"], date: null, bg: "#0a0a0a", ink: "#fff", accent: "#c8102e", headlineAsset: null, logoAsset: null, musicAsset: null, musicStart: 0, width: 1080, height: 1920 });
    await t("animated template (price drop) renders", async () => {
      const outA = await HyperFramesEngine.render(plan, adir, anim.html);
      const m = await probe(outA);
      assert.ok(Math.abs(m.duration - anim.duration) < 0.4, `${m.duration} vs ${anim.duration}`);
      const k2 = await keyframes(await readFile(outA), 4, 360);
      for (const [i, f] of k2.frames.entries()) await writeFile(path.join(process.env.CREATIVE_STORAGE_DIR!, `anim-frame-${i}.jpg`), f);
    });
  }

  await pool.end();
  console.log(`\n${passed} passed, ${failed.length} failed${failed.length ? `: ${failed.join(" · ")}` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
