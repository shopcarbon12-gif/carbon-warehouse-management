/**
 * CarbonWMS Email layout engine — slots, rendering and the 3-directions flow,
 * against a THROWAWAY Postgres (never a real database), no network:
 *   TEST_DB=postgres://postgres:test@127.0.0.1:55499/postgres npx tsx scripts/test-email-layout.ts
 * Run scripts/test-email-db.ts first (it creates the email tables).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { buildMaps, renderLayout, toKeys, toRefs, type LayoutTurn } from "../lib/server/email/layout";
import { STORE_MEDIA } from "../lib/server/email/brand";
import { offerLabel } from "../lib/server/email/campaigns";
import { parseOffer } from "../lib/server/email/validate";
import { addOwnerMessage, pickDirection } from "../lib/server/email/designer";
import type { CatalogProduct } from "../lib/server/email/catalog";

const url = process.env.TEST_DB ?? "";
if (!/127\.0\.0\.1:55499|localhost:55499/.test(url)) throw new Error("TEST_DB must point at the throwaway test Postgres on :55499");
const pool = new Pool({ connectionString: url });
const T = "00000000-0000-0000-0000-000000000001";

const prod = (n: number, ref: string): CatalogProduct => ({
  ref,
  id: `gid://shopify/Product/${n}`,
  title: `Item ${n}`,
  url: `https://shopcarbon.com/products/item-${n}`,
  type: "jacket",
  gender: "men",
  colors: ["Black"],
  sizes: ["M"],
  price: 50,
  compareAt: null,
  stock: 5,
  image: `https://cdn.shopify.com/item-${n}.jpg`,
});

(async () => {
  for (const f of ["0149_email_brand_media.sql", "0150_email_layout_engine.sql"]) {
    await pool.query(readFileSync(`scripts/migrations/${f}`, "utf8"));
    await pool.query(readFileSync(`scripts/migrations/${f}`, "utf8"));
  }
  console.log("ok  0150 applies twice");

  // Slots: planner refs ↔ stable keys (catalog numbers change between turns).
  const today = [prod(111, "P1"), prod(222, "P2")];
  const lib = [...STORE_MEDIA, { ref: "M1", id: "gid://shopify/MediaImage/999", url: "https://cdn.shopify.com/m.jpg", width: 2000, height: 800, kind: "campaign", description: "x" }];
  const maps = buildMaps(today, lib, [{ path: "email/designs/x/att/1.jpg", name: "a.jpg" }]);
  const planned = `<img src="{{img:P2:4x5}}"><a href="{{link:P2}}">x</a><img src="{{img:S1}}"><img src="{{img:M1:16x9}}"><img src="{{img:B1}}"><img src="{{img:A1}}"><img src="{{img:P99}}">`;
  const k = toKeys(planned, maps);
  assert.match(k.html, /\{\{img:p222:4x5\}\}/);
  assert.match(k.html, /\{\{link:p222\}\}/);
  assert.match(k.html, /\{\{img:s1\}\}/);
  assert.match(k.html, /\{\{img:m999:16x9\}\}/);
  assert.match(k.html, /\{\{img:b1\}\}/);
  assert.match(k.html, /\{\{img:a1\}\}/);
  assert.deepEqual(k.unknown, ["P99"]);
  // Next turn: the catalog shifted (item 222 is now P7, item 111 sold out).
  const later = buildMaps([prod(222, "P7")], lib, []);
  const back = toRefs(k.html, later);
  assert.match(back, /\{\{img:P7:4x5\}\}/);
  assert.match(back, /\{\{img:S1\}\}/);
  console.log("ok  slots survive catalog renumbering");

  // Render: banners + real photos; a missing picture's <img> is removed; logo files.
  const design = await pool.query<{ id: string }>(`INSERT INTO email_designs (tenant_id, title) VALUES ($1, 'Layout test') RETURNING id::text`, [T]);
  const designId = design.rows[0].id;
  const turn: LayoutTurn = {
    id: "11111111-2222-3333-4444-555555555555",
    design_id: designId,
    tenant_id: T,
    text: "",
    target: "both",
    mode: "fast",
    status: "generating",
    products: [{ id: "gid://shopify/Product/222", title: "Item 222", url: "https://shopcarbon.com/products/item-222", price: 50, image: "https://cdn.shopify.com/item-222.jpg?v=1" }],
    media: [],
    draft_html: null,
    banners: [
      { id: "B1", view: "both", size: "1536x1024", prompt: "", products: [], text: null, logo: false, url: "https://wms.example/b1.jpg" },
      { id: "B2", view: "both", size: "1536x1024", prompt: "", products: [], text: null, logo: false, url: null, error: "rejected" },
    ],
    direction: null,
    variant_group: null,
    variant_no: null,
    batch_files: null,
    created_at: new Date(),
  };
  const html = `<table><tr><td><img src="{{logo:white}}" width="160"><img src="{{img:b1}}" alt="hero"><img src="{{img:b2}}" alt="gone"><img src="{{img:p222}}" alt="tile"><a href="{{link:p222}}">Item</a> {{greeting_name}} {{code}}</td></tr></table>`;
  const r = await renderLayout(pool, turn, html);
  assert.match(r.html, /src="https:\/\/wms\.example\/b1\.jpg"/);
  assert.ok(!r.html.includes("gone"), "a banner that was not made is removed, never a broken picture");
  assert.match(r.html, /src="https:\/\/cdn\.shopify\.com\/item-222\.jpg\?v=1&width=1200"/, "an uncropped product photo is the original file");
  assert.match(r.html, /href="https:\/\/shopcarbon\.com\/products\/item-222"/);
  assert.match(r.html, /carbon-logo-long-white\.png/);
  assert.match(r.html, /\{\{greeting_name\}\} \{\{code\}\}/, "merge tags stay for sending");
  assert.ok(!/\{\{(img|link|logo):/.test(r.html));
  assert.deepEqual(r.missing, ["b2"]);
  console.log("ok  render: banners, original photos, links, logo, missing pictures removed");

  // 3 directions: three layout turns; the owner must pick before chatting on.
  const sent = await addOwnerMessage(pool, { designId, text: "AW2026 launch", attachments: [], target: "both", mode: "fast", by: "t@x", directions: true });
  assert.equal(sent.aiIds.length, 3);
  const rows = await pool.query<{ engine: string; variant_no: number; variant_group: string }>(`SELECT engine, variant_no, variant_group::text FROM email_design_messages WHERE id = ANY($1::uuid[]) ORDER BY variant_no`, [sent.aiIds]);
  assert.deepEqual(rows.rows.map((x) => [x.engine, x.variant_no]), [["layout", 1], ["layout", 2], ["layout", 3]]);
  assert.equal(new Set(rows.rows.map((x) => x.variant_group)).size, 1);
  await pool.query(`UPDATE email_design_messages SET status = 'done', html = '<table></table>' WHERE id = ANY($1::uuid[])`, [sent.aiIds]);
  await assert.rejects(addOwnerMessage(pool, { designId, text: "more", attachments: [], target: "both", mode: "fast", by: null }), /Pick one of the 3 directions/);
  await pickDirection(pool, designId, sent.aiIds[1]);
  const picked = await pool.query<{ picked: boolean }>(`SELECT picked FROM email_design_messages WHERE id = ANY($1::uuid[]) ORDER BY variant_no`, [sent.aiIds]);
  assert.deepEqual(picked.rows.map((x) => x.picked), [false, true, false]);
  const next = await addOwnerMessage(pool, { designId, text: "add 6 more items", attachments: [], target: "mobile", mode: "fast", by: null });
  assert.equal(next.aiIds.length, 1);
  console.log("ok  3 directions: grouped, must pick, then chat continues");

  // Percent-off offers.
  const o = parseOffer({ amount: 10, endsAt: new Date(Date.now() + 9 * 86400_000).toISOString(), kind: "percent", prefix: "AW" });
  assert.ok(o && o !== "invalid");
  assert.equal(offerLabel(o), "10%");
  assert.equal(parseOffer({ amount: 95, endsAt: new Date().toISOString(), kind: "percent" }), "invalid");
  assert.equal(offerLabel({ amount: 20, endsAt: "", minSubtotal: null, prefix: "X" }), "$20");
  console.log("ok  percent-off offers");

  await pool.end();
  console.log("\nall layout checks passed");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
