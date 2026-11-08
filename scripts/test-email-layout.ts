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
import { mergeValuesFor, offerLabel } from "../lib/server/email/campaigns";
import { fillMergeTags, wrapEmail } from "../lib/server/email/rules";
import { parseOffer } from "../lib/server/email/validate";
import { addOwnerMessage, approveItems, pickDirection } from "../lib/server/email/designer";
import { catalogLines, catalogSets, type CatalogProduct } from "../lib/server/email/catalog";

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
  handle: `item-${n}`,
  setPartners: [],
});

(async () => {
  for (const f of ["0149_email_brand_media.sql", "0150_email_layout_engine.sql", "0151_email_picture_review.sql", "0152_email_six_steps.sql", "0153_email_translations.sql"]) {
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

  // Matching sets: one card like the homepage (tops first, combined price), X-ref = the top's picture/link.
  const pc = (n: number, ref: string, title: string, price: number, partners: string[]): CatalogProduct => ({ ...prod(n, ref), title, price, handle: `h${n}`, setPartners: partners });
  const cat = [pc(1, "P1", "Elodie Jogger Set", 49, ["h2"]), pc(2, "P2", "Elodie Hoodie Set", 52, ["h1"]), pc(3, "P3", "Mara Top Set", 30, ["h9"]), prod(4, "P4")];
  const sets = catalogSets(cat);
  assert.equal(sets.length, 1, "a set with a sold-out piece is not offered");
  assert.equal(sets[0].name, "Elodie Set");
  assert.equal(sets[0].piecesLine, "Hoodie $52.00 + Jogger $49.00");
  assert.equal(sets[0].total, 101);
  assert.equal(sets[0].lead.ref, "P2");
  assert.match(catalogLines(cat, sets), /X1 \| Elodie Set \| Hoodie \$52\.00 \+ Jogger \$49\.00 \| Set \$101\.00 \| P2 \+ P1/);
  // The real Cole set (live catalog, 2026-11-08) reads like its homepage card.
  const cole = catalogSets([pc(5, "P5", "Cole Top Set", 67, ["h6"]), pc(6, "P6", "Cole Pants Set", 65, ["h5"])])[0];
  assert.deepEqual([cole.name, cole.piecesLine, cole.total.toFixed(2)], ["Cole Set", "Top $67.00 + Pants $65.00", "132.00"]);
  assert.match(catalogLines(cat, sets), /P1 \| Elodie Jogger Set .*piece of set X1/);
  const smaps = buildMaps(cat, lib, [], sets);
  assert.match(toKeys(`<img src="{{img:X1}}"><a href="{{link:X1}}">`, smaps).html, /\{\{img:p2\}\}.*\{\{link:p2\}\}/);
  console.log("ok  matching sets: one card, combined price, top's picture");

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

  // 3 directions (drawn pictures again, 2026-11-08): grouped, new layouts, items reviewed once; picking is optional.
  const sent = await addOwnerMessage(pool, { designId, text: "AW2026 launch", attachments: [], target: "both", mode: "fast", by: "t@x", directions: true });
  assert.equal(sent.aiIds.length, 3);
  const rows = await pool.query<{ engine: string; variant_no: number; variant_group: string; fresh: boolean; needs_review: boolean }>(
    `SELECT engine, variant_no, variant_group::text, fresh, needs_review FROM email_design_messages WHERE id = ANY($1::uuid[]) ORDER BY variant_no`,
    [sent.aiIds],
  );
  assert.deepEqual(rows.rows.map((x) => [x.engine, x.variant_no, x.fresh, x.needs_review]), [["picture", 1, true, true], ["picture", 2, true, true], ["picture", 3, true, true]]);
  assert.equal(new Set(rows.rows.map((x) => x.variant_group)).size, 1);
  await pool.query(`UPDATE email_design_messages SET status = 'done', desktop_path = 'd-' || variant_no, mobile_path = 'm-' || variant_no WHERE id = ANY($1::uuid[])`, [sent.aiIds]);
  // No pick needed: a plain message continues (from direction 1), keeping its "mobile only" choice.
  const next = await addOwnerMessage(pool, { designId, text: "bigger buttons on the phone", attachments: [], target: "mobile", mode: "fast", by: null });
  assert.equal(next.aiIds.length, 1);
  assert.equal((await pool.query<{ target: string }>(`SELECT target FROM email_design_messages WHERE id = $1::uuid`, [next.aiId])).rows[0].target, "mobile");
  // ... and another 3 directions can follow right away.
  await pool.query(`UPDATE email_design_messages SET status = 'failed' WHERE id = $1::uuid`, [next.aiId]);
  const again = await addOwnerMessage(pool, { designId, text: "three more", attachments: [], target: "mobile", mode: "fast", by: null, directions: true });
  assert.equal(again.aiIds.length, 3);
  await pool.query(`UPDATE email_design_messages SET status = 'failed' WHERE id = ANY($1::uuid[])`, [again.aiIds]);
  // Continuing from another direction is still possible.
  await pickDirection(pool, designId, sent.aiIds[1]);
  const picked = await pool.query<{ picked: boolean }>(`SELECT picked FROM email_design_messages WHERE id = ANY($1::uuid[]) ORDER BY variant_no`, [sent.aiIds]);
  assert.deepEqual(picked.rows.map((x) => x.picked), [false, true, false]);
  console.log("ok  3 directions: no forced pick, chat continues, 3 more any time");

  // Review step: the turn waits; the owner's message is blocked; approving with the same items keeps the briefs.
  const rv = await addOwnerMessage(pool, { designId, text: "winter looks", attachments: [], target: "both", mode: "fast", by: null });
  const items = [{ id: "gid://shopify/Product/222", title: "Item 222", url: "u", price: 50, image: null, set: null }];
  await pool.query(`UPDATE email_design_messages SET status = 'review', products = $2, media = '[]', desktop_prompt = 'D', mobile_prompt = 'M' WHERE id = $1::uuid`, [rv.aiId, JSON.stringify(items)]);
  await assert.rejects(addOwnerMessage(pool, { designId, text: "x", attachments: [], target: "both", mode: "fast", by: null }), /approve/);
  await approveItems(pool, designId, rv.aiId, ["gid://shopify/Product/222"], []);
  const ap = await pool.query<{ status: string; desktop_prompt: string | null }>(`SELECT status, desktop_prompt FROM email_design_messages WHERE id = $1::uuid`, [rv.aiId]);
  assert.deepEqual([ap.rows[0].status, ap.rows[0].desktop_prompt], ["approved", "D"]);
  // Removing an item clears the briefs (they are rewritten around the approved items).
  await pool.query(`UPDATE email_design_messages SET status = 'review' WHERE id = $1::uuid`, [rv.aiId]);
  await approveItems(pool, designId, rv.aiId, [], []);
  const ap2 = await pool.query<{ status: string; desktop_prompt: string | null; products: unknown[] }>(`SELECT status, desktop_prompt, products FROM email_design_messages WHERE id = $1::uuid`, [rv.aiId]);
  assert.deepEqual([ap2.rows[0].status, ap2.rows[0].desktop_prompt, ap2.rows[0].products.length], ["approved", null, 0]);
  console.log("ok  review: waits, blocks new messages, approve keeps or rewrites the briefs");

  // Outfit review (owner, 2026-11-08): each person's outfit is edited in its own row; the concept keeps them,
  // and only the photo whose outfit changed is drawn again.
  await pool.query(`UPDATE email_design_messages SET status = 'failed' WHERE design_id = $1::uuid AND status <> 'done' AND role = 'ai'`, [designId]);
  const ov = await addOwnerMessage(pool, { designId, text: "outfits", attachments: [], target: "both", mode: "fast", by: null });
  const P = (n: number) => `gid://shopify/Product/${n}`;
  const concept = {
    story: "s", photo_style: "x",
    hero: { scene: "hero", headline: "H", products: [P(1), P(2)], people: [{ who: "man", products: [P(1)] }, { who: "woman", products: [P(2)] }] },
    looks: [{ id: "l1", name: "One", scene: "a", mood: "m", copy: "c", products: [P(1)], people: [{ who: "man", products: [P(1)] }] }],
    offer: { headline: "o", text: "t" }, showroom: { headline: "s", text: "t" },
  };
  const shots0 = [
    { id: "h1", kind: "hero", size: "1536x1024", prompt: "hero", products: [P(1), P(2)], people: [{ who: "man", products: [P(1)] }, { who: "woman", products: [P(2)] }], path: "h.jpg", qa: null },
    { id: "l1", kind: "look", size: "1024x1536", prompt: "a", products: [P(1)], people: [{ who: "man", products: [P(1)] }], path: "l1.jpg", qa: null },
  ];
  const prods = [1, 2, 3].map((n) => ({ id: P(n), title: `Item ${n}`, url: "u", price: 10, image: null, set: null }));
  await pool.query(`UPDATE email_design_messages SET status = 'review', concept_data = $2, shots = $3, products = $4, media = '[]' WHERE id = $1::uuid`, [ov.aiId, JSON.stringify(concept), JSON.stringify(shots0), JSON.stringify(prods)]);
  // The woman in the hero gets item 3 instead of item 2 (item 3 is not in the test catalog, but was picked before).
  await approveItems(pool, designId, ov.aiId, [P(1), P(3)], [], [
    { key: "h1", person: 0, productIds: [P(1)] },
    { key: "h1", person: 1, productIds: [P(3)] },
    { key: "l1", person: 0, productIds: [P(1)] },
  ]);
  const after = (await pool.query<{ status: string; concept_data: typeof concept; shots: typeof shots0 }>(`SELECT status, concept_data, shots FROM email_design_messages WHERE id = $1::uuid`, [ov.aiId])).rows[0];
  assert.equal(after.status, "approved");
  assert.deepEqual(after.concept_data.hero.people[1].products, [P(3)], "the woman's outfit is the owner's");
  assert.deepEqual(after.concept_data.hero.products.sort(), [P(1), P(3)].sort());
  assert.equal(after.shots.find((x) => x.id === "h1")!.path, null, "the hero (outfit changed) is drawn again");
  assert.equal(after.shots.find((x) => x.id === "l1")!.path, "l1.jpg", "look 1 (unchanged) keeps its photo");
  console.log("ok  outfit review: per-person edits kept, only changed photos redrawn");

  // Spanish + Portuguese: a bold language bar on top, links to this person's web pages, translated footer.
  const wrapped = wrapEmail({ designHtml: "<table><tr><td>Hola</td></tr></table>", subject: "s", preheader: "p", postalAddress: "Addr", lang: "es", languages: ["en", "es", "pt"] });
  assert.match(wrapped, /READ THIS EMAIL IN ENGLISH/);
  assert.match(wrapped, /LEIA ESTE E-MAIL EM PORTUGUÊS/);
  assert.ok(!/LEE ESTE CORREO EN ESPAÑOL/.test(wrapped), "no link to the language you are reading");
  assert.match(wrapped, /Darse de baja/);
  const filled = fillMergeTags(wrapped, mergeValuesFor({ firstName: null, code: "X-1", offer: null, unsubToken: "tok123456", campaignId: "11111111-1111-1111-1111-111111111111", lang: "es" }));
  assert.match(filled, /\/api\/public\/email\/web\/11111111-1111-1111-1111-111111111111\/tok123456\/en/);
  assert.ok(!/LEE ESTE|READ THIS/.test(wrapEmail({ designHtml: "<table></table>", subject: "s", preheader: "p", postalAddress: "A" })), "no bar without translations");
  console.log("ok  language bar: bold links to the other languages, translated footer, per-person web links");

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
