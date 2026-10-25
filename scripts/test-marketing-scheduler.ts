/**
 * Social scheduler test against a real Postgres (DATABASE_URL) with
 * migration 0136 applied, and a fake Meta Graph API (no network).
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/test-marketing-scheduler.ts
 *
 * Proves: nothing goes out while publishing is off, without an approval, for
 * drafts, for future posts or for posts more than 6 h late; due approved posts
 * go to Instagram (with product tags) and Facebook; a failing channel retries
 * up to 3 times without blocking the other channel.
 */
import { Pool } from "pg";
import assert from "node:assert/strict";

process.env.META_SYSTEM_USER_TOKEN = "test-token";

type Call = { path: string; method: string; params: Record<string, string> };
const calls: Call[] = [];
let failInstagram = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (!url.hostname.endsWith("facebook.com")) return realFetch(input, init);
  const path = url.pathname.replace(/^\/v21\.0\//, "");
  const method = init?.method ?? "GET";
  const params = Object.fromEntries(method === "GET" ? url.searchParams : new URLSearchParams(String(init?.body ?? "")));
  calls.push({ path, method, params });
  const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
  if (failInstagram && path.startsWith("IG1/")) return new Response(JSON.stringify({ error: { message: "Fake Instagram outage", code: 2 } }), { status: 500 });
  if (path === "IG1/media") return ok({ id: `C${calls.length}` });
  if (path === "IG1/media_publish") return ok({ id: "IGMEDIA1" });
  if (path === "IGMEDIA1") return ok({ permalink: "https://instagram.com/p/fake" });
  if (path === "PAGE1" && params.fields === "access_token") return ok({ access_token: "page-token" });
  if (path === "PAGE1/photos") return ok({ id: "PHOTO1", post_id: "PAGE1_POST1" });
  if (path === "PAGE1_POST1") return ok({ permalink_url: "https://facebook.com/fake" });
  return ok({});
}) as typeof fetch;

const TENANT = "11111111-1111-1111-1111-111111111111";

async function main() {
  const { runDuePosts } = await import("@/lib/server/marketing/scheduler");
  const { fullCaption } = await import("@/lib/server/marketing/store");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`TRUNCATE marketing_settings, marketing_channels, marketing_posts, marketing_best_times CASCADE`);
  await pool.query(`INSERT INTO marketing_channels (tenant_id, provider, account_id, name) VALUES ($1,'instagram','IG1','@shopcarbon'), ($1,'facebook','PAGE1','Shop Carbon')`, [TENANT]);

  async function post(ref: string, status: string, offsetMin: number, approvedBy: string | null = "owner@carbon") {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO marketing_posts (tenant_id, source_ref, title, format, caption, hashtags, link_url, scheduled_at, status, approved_by, approved_at)
       VALUES ($1,$2,$2,'image','Caption for '||$2, ARRAY['TheArtOfArriving'], 'https://shopcarbon.com/products/x', now() + ($3 || ' minutes')::interval, $4, $5, CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)
       RETURNING id`,
      [TENANT, ref, String(offsetMin), status, approvedBy],
    );
    const id = r.rows[0].id;
    await pool.query(`INSERT INTO marketing_post_media (post_id, position, kind, url) VALUES ($1,0,'image','https://cdn.example/x.jpg')`, [id]);
    await pool.query(`INSERT INTO marketing_post_tags (post_id, media_position, meta_product_id, label, x, y) VALUES ($1,0,'25908652898828707','Brooks Coat',0.4,0.5)`, [id]);
    await pool.query(`INSERT INTO marketing_post_targets (post_id, provider) VALUES ($1,'instagram'),($1,'facebook')`, [id]);
    return id;
  }
  const status = async (id: string) => (await pool.query<{ status: string }>(`SELECT status FROM marketing_posts WHERE id=$1`, [id])).rows[0].status;
  const targets = async (id: string) =>
    Object.fromEntries((await pool.query<{ provider: string; status: string; attempts: number; permalink: string | null }>(`SELECT provider, status, attempts, permalink FROM marketing_post_targets WHERE post_id=$1`, [id])).rows.map((r) => [r.provider, r]));

  const due = await post("due", "approved", -2);
  const draft = await post("draft", "draft", -2, null);
  const noApprover = await post("noapprover", "approved", -2, null);
  const future = await post("future", "approved", 60);
  const tooLate = await post("late", "approved", -7 * 60);

  // 1. Publishing switch off → nothing happens.
  let r = await runDuePosts(pool);
  assert.deepEqual(r, { published: 0, failed: 0 });
  assert.equal(calls.length, 0, "no Meta calls while publishing is off");

  // 2. Switch on → only the due, approved, approver-signed post goes out.
  await pool.query(`INSERT INTO marketing_settings (tenant_id, publish_enabled) VALUES ($1, true)`, [TENANT]);
  r = await runDuePosts(pool);
  assert.deepEqual(r, { published: 1, failed: 0 });
  assert.equal(await status(due), "published");
  for (const id of [draft, noApprover, future, tooLate]) assert.notEqual(await status(id), "published");
  const t = await targets(due);
  assert.equal(t.instagram.status, "published");
  assert.equal(t.instagram.permalink, "https://instagram.com/p/fake");
  assert.equal(t.facebook.status, "published");
  const igCreate = calls.find((c) => c.path === "IG1/media")!;
  assert.equal(igCreate.params.caption, "Caption for due\n\n#TheArtOfArriving");
  assert.deepEqual(JSON.parse(igCreate.params.product_tags), [{ product_id: "25908652898828707", x: 0.4, y: 0.5 }]);
  const fbPost = calls.find((c) => c.path === "PAGE1/photos")!;
  assert.match(fbPost.params.message, /https:\/\/shopcarbon\.com\/products\/x$/);
  assert.equal(fbPost.params.access_token, "page-token");

  // 3. Running again publishes nothing twice.
  const before = calls.length;
  r = await runDuePosts(pool);
  assert.deepEqual(r, { published: 0, failed: 0 });
  assert.equal(calls.length, before);

  // 4. Instagram down → Facebook still goes out; Instagram retries up to 3 times, then the post is partly published.
  failInstagram = true;
  const flaky = await post("flaky", "approved", -1);
  await runDuePosts(pool);
  assert.equal((await targets(flaky)).facebook.status, "published");
  assert.equal((await targets(flaky)).instagram.attempts, 1);
  assert.equal(await status(flaky), "approved", "retryable → back in the queue");
  await runDuePosts(pool);
  await runDuePosts(pool);
  assert.equal((await targets(flaky)).instagram.attempts, 3);
  assert.equal(await status(flaky), "partly_published");
  assert.equal((await targets(flaky)).facebook.status, "published", "Facebook was not re-posted on retries");
  assert.equal(calls.filter((c) => c.path === "PAGE1/photos").length, 2, "one Facebook post per post, never duplicated");

  assert.equal(fullCaption({ caption: "Hi ", hashtags: ["a", "#b"] }), "Hi\n\n#a #b");
  await pool.end();
  console.log("marketing scheduler: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
