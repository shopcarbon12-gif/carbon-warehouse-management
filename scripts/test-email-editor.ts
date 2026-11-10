/**
 * CarbonWMS Email Editor — tests.
 *   npx tsx scripts/test-email-editor.ts                       (renderer + editing rules, no database)
 *   TEST_DB=postgres://postgres:test@127.0.0.1:55499/postgres npx tsx scripts/test-email-editor.ts
 *                                                             (+ create / save / versions on the THROWAWAY Postgres)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { renderBlock, renderEmail, styleText } from "../lib/email-editor/render";
import { PREBUILT, STARTERS, prebuiltSections } from "../lib/email-editor/prebuilt";
import { blankDoc, defaultStyles, isDoc, newBlock, newSection, type EmailDoc, type ProductBlock } from "../lib/email-editor/types";
import { fillMergeTags, usedMergeTags, wrapEmail } from "../lib/server/email/rules";
import { addNewBlock, duplicateBlock, findBlock, moveBlock, moveSection, removeBlock, setLayout } from "../components/email/editor/state";

let n = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  await fn();
  n++;
  console.log(`ok  ${name}`);
}

async function main() {
  await t("every starter renders a real email: no editor placeholders, phone rules, page colour mark", () => {
    for (const s of STARTERS) {
      const d = s.make();
      assert.ok(isDoc(d), s.id);
      const html = renderEmail(d);
      assert.ok(html.includes('class="ce-wrap"'), s.id);
      assert.ok(html.includes("@media only screen and (max-width:620px)"), s.id);
      assert.ok(html.includes(`<!--carbon-bg:${d.styles.pageBg}-->`), s.id);
      assert.ok(!/Drop an image here|Drop content here|Product name<|\$X\.XX|display:flex/.test(html), `${s.id}: editor placeholder in the email`);
      assert.ok(html.length < 100_000, `${s.id}: ${html.length} bytes`);
    }
  });

  await t("fonts: an email loads only the web fonts it uses; toolbar fonts get their fallback", async () => {
    const { fixFamilies } = await import("../lib/email-editor/render");
    const { FONTS } = await import("../lib/email-editor/types");
    assert.ok(FONTS.length >= 50);
    const plain = renderEmail(blankDoc());
    assert.ok(!plain.includes("fonts.googleapis.com"), "Helvetica only: no web font");
    const ed = STARTERS.find((x) => x.id === "editorial")!.make();
    const html = renderEmail(ed);
    assert.ok(html.includes("@import url('https://fonts.googleapis.com/css2?family=Bodoni+Moda"), "Bodoni loaded");
    assert.ok(html.includes("family=Great+Vibes") && html.includes("family=Montserrat"));
    assert.ok(!html.includes("family=Bebas+Neue"), "unused fonts are not loaded");
    assert.ok(html.includes("font-family:'Bodoni Moda',Georgia,'Times New Roman',serif"), "with its serif fallback for Gmail");
    assert.equal(fixFamilies('<span style="font-family: &quot;Bebas Neue&quot;;">x</span>'), `<span style="font-family:'Bebas Neue',Impact,'Arial Narrow',Arial,sans-serif;">x</span>`);
    assert.equal(fixFamilies('<span style="font-family: Montserrat;">x</span>'), `<span style="font-family:'Montserrat',Helvetica,Arial,sans-serif;">x</span>`);
  });

  await t("every pre-built section can be inserted", () => {
    for (const p of PREBUILT) assert.ok(prebuiltSections(p.id).length >= 1, p.id);
    assert.equal(prebuiltSections("store").length, 3);
  });

  await t("product block: prices, sale price, matching set card, empty cells left out of the email", () => {
    const b = newBlock("product") as ProductBlock;
    b.source = "static";
    b.perRow = 3;
    b.items = [
      { id: "1", title: "Lilith Sweater", price: 51, compareAt: 68, image: "https://cdn.shopify.com/a.jpg", url: "https://shopcarbon.com/products/lilith-sweater" },
      { id: "set:2", title: "Gordon Set", price: 140, compareAt: null, image: "https://cdn.shopify.com/b.jpg", url: "https://shopcarbon.com/products/gordon-hoodie-set", set: { line: "Hoodie $71.00 + Pants $69.00", total: 140, pieces: 2 } },
    ];
    const html = renderBlock(b, { styles: defaultStyles(), width: 564, mobile: false });
    assert.ok(html.includes("$51.00") && html.includes("$68.00") && html.includes("line-through"));
    assert.ok(html.includes("2-PIECE SET") && html.includes("Hoodie $71.00 + Pants $69.00") && html.includes("Set $140.00"));
    assert.ok(html.includes('class="ce-p2"'), "3 per row become 2 per row on phones");
    const dyn = newBlock("product") as ProductBlock;
    assert.equal(renderBlock(dyn, { styles: defaultStyles(), width: 564, mobile: false }), "", "a feed with no products is left out of the email");
    assert.ok(renderBlock(dyn, { styles: defaultStyles(), width: 564, mobile: false, canvas: true }).includes("Product name"), "the canvas shows placeholders");
  });

  await t("visibility: phone-only hidden on desktop with a phone rule; desktop-only gets the hide class", () => {
    const b = newBlock("text");
    b.visibility = "mobile";
    const html = renderBlock(b, { styles: defaultStyles(), width: 564, mobile: false });
    assert.ok(html.includes('class="ce-m"') && html.includes("display:none;max-height:0"));
    b.visibility = "desktop";
    assert.ok(renderBlock(b, { styles: defaultStyles(), width: 564, mobile: false }).includes('class="ce-d"'));
    assert.equal(renderBlock(b, { styles: defaultStyles(), width: 375, mobile: true, canvas: true }), "", "the phone canvas hides a desktop-only block");
  });

  await t("text: email styles inlined, the block's own alignment/colour wins, phone sizes on the phone canvas", () => {
    const s = defaultStyles();
    const out = styleText('<h1 style="text-align:center;color:#ff0000">Hi</h1><p>Body <a href="https://x.com">link</a></p>', s, false);
    assert.match(out, /<h1 class="ce-h1" style="margin:0;font-family:Helvetica[^"]*font-size:40px[^"]*text-align:left;text-align:center;color:#ff0000">/);
    assert.match(out, /<a href="https:\/\/x.com" style="color:#111111;[^"]*text-decoration:underline;">/);
    assert.ok(styleText("<h1>x</h1>", s, true).includes("font-size:32px"));
  });

  await t("links: javascript: links dropped, bare domains get https, merge tags kept", () => {
    const b = newBlock("button");
    if (b.type !== "button") throw new Error();
    b.href = "javascript:alert(1)";
    assert.ok(renderBlock(b, { styles: defaultStyles(), width: 564, mobile: false }).includes('href="#"'));
    b.href = "shopcarbon.com/collections/new";
    assert.ok(renderBlock(b, { styles: defaultStyles(), width: 564, mobile: false }).includes('href="https://shopcarbon.com/collections/new"'));
    const c = newBlock("code");
    const ch = renderBlock(c, { styles: defaultStyles(), width: 564, mobile: false });
    assert.ok(ch.includes("{{code}}") && ch.includes('href="{{code_url}}"') && ch.includes("{{offer_amount}}"));
  });

  await t("merge tags: {{first_name|friend}} falls back, values win, used tags found", () => {
    assert.equal(fillMergeTags("Hi {{first_name|friend}}!", {}), "Hi friend!");
    assert.equal(fillMergeTags("Hi {{ first_name | friend }}!", { first_name: "Ana" }), "Hi Ana!");
    assert.equal(fillMergeTags("Hi {{first_name|friend}}!", { first_name: "" }), "Hi friend!");
    assert.equal(fillMergeTags("{{first_name|<b>x</b>}}", {}), "&lt;b&gt;x&lt;/b&gt;");
    assert.deepEqual(usedMergeTags("{{code}} {{first_name|you}}").sort(), ["code", "first_name"]);
  });

  await t("the footer sits on the email's page colour", () => {
    const d = blankDoc();
    d.styles.pageBg = "#EFEBE4";
    const html = wrapEmail({ designHtml: renderEmail(d), subject: "s", preheader: "p", postalAddress: "Carbon · Orlando" });
    assert.ok(html.includes('<body style="margin:0;padding:0;background:#EFEBE4;">'));
    assert.ok(html.includes('style="background:#EFEBE4;"><tr><td align="center" style="padding:8px 16px 32px;">'));
    assert.ok(html.includes("{{unsubscribe_url}}"));
  });

  await t("editing: add, move across sections, duplicate, delete, change columns, move sections", () => {
    let d: EmailDoc = { v: 1, styles: defaultStyles(), sections: [newSection([100]), newSection([50, 50])] };
    const [s1, s2] = d.sections;
    const a = addNewBlock(d, { section: s1.id, col: 0, index: 0 }, "text");
    d = a.doc;
    const b = addNewBlock(d, { section: s1.id, col: 0, index: 1 }, "image");
    d = b.doc;
    d = moveBlock(d, a.id, { section: s1.id, col: 0, index: 2 });
    assert.deepEqual(d.sections[0].cols[0].blocks.map((x) => x.id), [b.id, a.id], "moved below the image");
    d = moveBlock(d, a.id, { section: s2.id, col: 1, index: 0 });
    assert.equal(findBlock(d, a.id)?.s, 1);
    assert.equal(findBlock(d, a.id)?.c, 1);
    const dup = duplicateBlock(d, a.id);
    d = dup.doc;
    assert.notEqual(dup.id, a.id);
    assert.equal(d.sections[1].cols[1].blocks.length, 2);
    d = setLayout(d, s2.id, [100]);
    assert.equal(d.sections[1].cols.length, 1);
    assert.equal(d.sections[1].cols[0].blocks.length, 2, "blocks of a removed column are kept");
    d = removeBlock(d, dup.id);
    assert.equal(findBlock(d, dup.id), null);
    d = moveSection(d, s2.id, 0);
    assert.equal(d.sections[0].id, s2.id);
  });

  await t("headline pictures: one key per look, personal tags and paragraphs stay text, the canvas keeps live text", async () => {
    const { picSources, picBlocked, renderBlock: rb } = await import("../lib/email-editor/render");
    const d = STARTERS.find((x) => x.id === "drop")!.make();
    const src = picSources(d);
    assert.ok(src.length >= 1, "the drop starter's Bebas headline is a picture");
    const heat = src.find((p) => p.alt === "NEW HEAT")!;
    assert.ok(heat && /^[0-9a-f]{16}$/.test(heat.key));
    assert.equal(heat.bg, "#0E0E0E", "drawn on the section colour (no see-through text in dark mode)");
    assert.ok(heat.page.includes("family=Bebas+Neue") && heat.page.includes(`width:${heat.width}px`));
    assert.equal(picSources(STARTERS.find((x) => x.id === "drop")!.make())[0].key, src[0].key, "same look → same key");
    // Without the picture yet: the words go out as text. With it: an <img> with the words as alt.
    assert.ok(!renderEmail(d).includes("pic-") && renderEmail(d).includes("NEW HEAT"));
    const html = renderEmail(d, { [heat.key]: { url: `https://x/pic-${heat.key}.png`, w: heat.width, h: 90 } });
    assert.ok(new RegExp(`<img src="https://x/pic-${heat.key}\\.png" alt="NEW HEAT" width="${heat.width}" class="ce-imgm"[^>]*color:#FFFFFF`).test(html), "alt words light on black");
    // A different colour, width or word is a new picture.
    const d2 = structuredClone(d);
    d2.sections.forEach((s) => s.cols.forEach((c) => c.blocks.forEach((b) => b.type === "text" && b.asPic && (b.html = b.html.replace("NEW HEAT", "NEW DROP")))));
    assert.notEqual(picSources(d2).find((p) => p.alt === "NEW DROP")!.key, heat.key);
    assert.match(picBlocked("<h1>Hi {{first_name|friend}}</h1>") ?? "", /personal tag/);
    assert.match(picBlocked(`<p>${"word ".repeat(80)}</p>`) ?? "", /too long/);
    assert.equal(picBlocked("<h1>Worth the detour</h1>"), null);
    const blk = newBlock("text");
    if (blk.type === "text") {
      blk.asPic = true;
      blk.html = "<h1>Hello</h1>";
    }
    const canvas = rb(blk, { styles: defaultStyles(), width: 600, mobile: false, canvas: true, pics: {} });
    assert.ok(canvas.includes("Hello") && !canvas.includes("<img"), "the canvas stays editable text");
  });

  await t("AI Designer switched off: no new messages unless EMAIL_AI_DESIGNER=on", async () => {
    const { aiDesignerOff } = await import("../lib/server/email/config");
    const was = process.env.EMAIL_AI_DESIGNER;
    delete process.env.EMAIL_AI_DESIGNER;
    assert.equal(aiDesignerOff(), true);
    const { addOwnerMessage } = await import("../lib/server/email/designer");
    await assert.rejects(addOwnerMessage(null as never, { designId: "x", text: "x", attachments: [], target: "both", mode: "fast", by: null }), /switched off/);
    process.env.EMAIL_AI_DESIGNER = "on";
    assert.equal(aiDesignerOff(), false);
    if (was === undefined) delete process.env.EMAIL_AI_DESIGNER;
    else process.env.EMAIL_AI_DESIGNER = was;
  });

  await t("headline pictures: Chromium draws the real web font at 2x", async () => {
    const { draw } = await import("../lib/server/email/text-pics");
    const { picPage } = await import("../lib/email-editor/render");
    const sharp = (await import("sharp")).default;
    const st = defaultStyles();
    const frag = (fam: string) => `<div><h1 style="margin:0;font-family:'${fam}',Arial,sans-serif;font-size:96px;line-height:1;color:#111111;text-align:left;">NEW HEAT</h1></div>`;
    const jobs = [
      { key: "bebas", page: picPage(frag("Bebas Neue"), 500, "#FFFFFF", st), bg: "#FFFFFF", alt: "NEW HEAT" },
      { key: "arial", page: picPage(frag("Arial"), 500, "#FFFFFF", st), bg: "#FFFFFF", alt: "NEW HEAT" },
    ];
    const out = await draw(jobs, () => {});
    const size = async (png: Buffer) => sharp(png).metadata();
    const b = await size(out.get("bebas")!);
    const a = await size(out.get("arial")!);
    assert.equal(b.width, 1000, "2x the 500 px block");
    // Bebas Neue (condensed) fits "NEW HEAT" on one line at 96 px; Arial needs two. Proves the web font loaded.
    assert.ok(b.height! < a.height! * 0.7, `Bebas ${b.height} vs Arial ${a.height}`);
  });

  await t("CARBON pack: 10 templates, every hero a JPG picture source, small HTML, images with width + alt, footer rule, no 'Carbon Jeans'", async () => {
    const { PACK, PACK_MORE } = await import("../lib/email-editor/pack");
    const { HERO_LAYOUT_IDS, heroPage, heroDefaults, heroInfo } = await import("../lib/email-editor/heroes");
    const { picSources } = await import("../lib/email-editor/render");
    const { MERGE_TAGS } = await import("../lib/server/email/rules");
    assert.equal(PACK.length, 10);
    assert.equal(PACK_MORE.length, 60);
    assert.equal(STARTERS.filter((x) => x.group?.startsWith("pack")).length, 70);
    for (const p of [...PACK, ...PACK_MORE]) {
      const d = p.make();
      assert.ok(isDoc(d), p.id);
      const html = renderEmail(d);
      assert.ok(html.length < 100_000, `${p.id}: ${html.length} bytes`);
      assert.ok(!/carbon jeans/i.test(html), `${p.id}: says Carbon Jeans`);
      assert.ok(!/japan/i.test(html), `${p.id}: names a country`);
      for (const m of html.matchAll(/<img\b[^>]*>/g)) {
        assert.ok(/\swidth="\d+"/.test(m[0]), `${p.id}: img without width ${m[0].slice(0, 120)}`);
        assert.ok(/\salt="/.test(m[0]), `${p.id}: img without alt`);
      }
      const heroes = picSources(d).filter((x) => x.jpg);
      assert.equal(heroes.length, 1, `${p.id}: one hero picture`);
      assert.ok(heroes[0].page.includes("__heroReady"), "the page fits its headlines");
      assert.ok(!heroes[0].page.includes("guide{display") || heroes[0].page.includes(".guide{display:none"), `${p.id}: guide labels hidden in the sent picture`);
      for (const m of html.matchAll(/\{\{\s*([A-Za-z_#/]+)/g)) assert.ok((MERGE_TAGS as readonly string[]).includes(m[1]), `${p.id}: unknown personal tag {{${m[1]}}}`);
      assert.ok(!/\.\.\/assets\//.test(html), `${p.id}: a relative pack path is left`);
    }
    // every pack hero (11–70): its words are editable and escaped, photos swap in
    for (const id of HERO_LAYOUT_IDS.filter((x) => heroInfo(x).pack)) {
      const d = heroDefaults(id);
      const page = heroPage({ ...d, texts: d.texts!.map((t, i) => (i === 0 ? "<b>X</b>" : t)), photos: d.photos.map(() => "https://cdn.example/p.jpg") });
      assert.ok(!page.includes("<b>X</b>") && page.includes("&lt;b&gt;X&lt;/b&gt;"), `${id}: words escaped`);
      if (d.photos.length) assert.ok(page.includes('src="https://cdn.example/p.jpg"'), `${id}: photo swapped in`);
      assert.ok(!/\u0001/.test(page), `${id}: a slot marker is left`);
      assert.ok(!page.includes("../assets/"), `${id}: relative asset path`);
    }
    assert.equal(HERO_LAYOUT_IDS.length, 70);
    // the words and photos change the picture (a new key); the same hero in two emails is one picture
    const a = heroPage(heroDefaults("monument"));
    assert.notEqual(a, heroPage({ ...heroDefaults("monument"), headline: "BLACK DENIM" }));
    assert.equal(a, heroPage(heroDefaults("monument")));
    assert.ok(!heroPage({ ...heroDefaults("quiet"), headline: '<script>alert(1)</script>' }).includes("<script>alert"), "headline escaped");
  });

  await t("calendar: floating holidays, send days, order; countdown block", async () => {
    const { CALENDAR, nthWeekday, upcoming } = await import("../lib/email-editor/calendar");
    const day = (id: string, y: number) => CALENDAR.find((x) => x.template === id)!.day(y).toISOString().slice(0, 10);
    assert.equal(day("25-black-friday", 2026), "2026-11-27");
    assert.equal(day("27-cyber-monday", 2026), "2026-11-30");
    assert.equal(day("26-small-business-saturday", 2026), "2026-11-28");
    assert.equal(day("15-mothers-day", 2027), "2027-05-09");
    assert.equal(day("13-presidents-day", 2027), "2027-02-15");
    assert.equal(day("16-memorial-day", 2027), "2027-05-31");
    assert.equal(day("22-labor-day", 2027), "2027-09-06");
    assert.equal(nthWeekday(2026, 11, 4, 4).toISOString().slice(0, 10), "2026-11-26");
    const u = upcoming(new Date("2026-11-10T15:00:00Z"), 400);
    assert.equal(u[0].template, "24-singles-day");
    assert.equal(u[0].daysLeft, 1);
    const val = u.filter((x) => x.template === "12-valentines").map((x) => x.sendOn);
    assert.deepEqual(val, ["2027-02-07", "2027-02-11"], "Valentine's goes out Feb 7 and Feb 11");
    assert.ok(u.every((x, i) => i === 0 || x.daysLeft >= u[i - 1].daysLeft));
    const cd = newBlock("countdown");
    const html = renderBlock(cd, { styles: defaultStyles(), width: 600, mobile: false });
    assert.ok(html.includes("https://wms.shopcarbon.com/api/public/email/countdown?to=") && /alt="Ends /.test(html) && /width="540"/.test(html));
  });

  await t("countdown picture: 60 frames, one per second, stops at zero", async () => {
    const { countdownGif } = await import("../lib/server/email/countdown");
    const sharp = (await import("sharp")).default;
    const g = await countdownGif(new URLSearchParams({ to: new Date(Date.now() + 90_000).toISOString(), bg: "0A0A0A", fg: "F2EFE8" }));
    const m = await sharp(g, { animated: true }).metadata();
    assert.equal(m.format, "gif");
    assert.equal(m.pages, 60);
    const over = await countdownGif(new URLSearchParams({ to: "2020-01-01T00:00:00Z" }));
    assert.equal((await sharp(over, { animated: true }).metadata()).pages, 1, "an ended countdown is one still frame");
  });

  const url = process.env.TEST_DB ?? "";
  if (!url) {
    console.log(`\n${n} groups passed (no TEST_DB: database part skipped)`);
    return;
  }
  if (!/127\.0\.0\.1:55499|localhost:55499/.test(url)) throw new Error("TEST_DB must point at the throwaway test Postgres on :55499");
  const { createEditorEmail, getEditorEmail, saveEditorEmail, listVersions, editorHtml } = await import("../lib/server/email/editor");
  const pool = new Pool({ connectionString: url });
  const T = "00000000-0000-0000-0000-000000000001";
  try {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    for (let pass = 0; pass < 2; pass++)
      for (const f of ["0147_email_campaigns.sql", "0148_email_design_products.sql", "0149_email_brand_media.sql", "0150_email_layout_engine.sql", "0151_email_picture_review.sql", "0152_email_six_steps.sql", "0153_email_translations.sql", "0154_email_styles.sql", "0155_email_editor.sql", "0156_email_text_pics.sql", "0157_email_library.sql", "0158_email_flows.sql", "0159_email_segments_ab.sql", "0160_email_hero_pages.sql"])
        await pool.query(readFileSync(`scripts/migrations/${f}`, "utf8"));
    console.log("ok  migrations (with 0155–0159) apply twice");

    await t("create from a starter: a ready design with html, listed as an editor email", async () => {
      const id = await createEditorEmail(pool, T, "owner@shopcarbon.com", { starter: "collection" });
      const e = await getEditorEmail(pool, T, id);
      assert.ok(e && e.title === "New collection" && e.doc.sections.length > 3);
      const row = await pool.query(`SELECT status, html, check_status FROM email_designs WHERE id = $1`, [id]);
      assert.equal(row.rows[0].status, "ready");
      assert.equal(row.rows[0].check_status, null, "no AI visual check needed: a campaign can use it");
      assert.ok(row.rows[0].html.includes("<!--carbon-bg:"), "the page colour survives sanitizing");
      assert.equal(await getEditorEmail(pool, "00000000-0000-0000-0000-000000000002", id), null, "other stores never see it");
    });

    await t("save: html re-rendered, translations dropped only when the email changed, versions kept", async () => {
      const id = await createEditorEmail(pool, T, null, { starter: "blank" });
      await pool.query(`UPDATE email_designs SET html_es = 'es', html_pt = 'pt', translate_status = 'done' WHERE id = $1`, [id]);
      const e = (await getEditorEmail(pool, T, id))!;
      const same = await saveEditorEmail(pool, T, id, { doc: e.doc, subject: "Hello {{first_name|there}}" }, "a");
      assert.equal(same.translationsDropped, false);
      assert.equal((await getEditorEmail(pool, T, id))!.has_es, true, "subject change keeps translations");
      const d = structuredClone(e.doc);
      d.sections[1].cols[0].blocks.push(newBlock("text"));
      const changed = await saveEditorEmail(pool, T, id, { doc: d, title: "Renamed" }, "a");
      assert.equal(changed.translationsDropped, true);
      const after = (await getEditorEmail(pool, T, id))!;
      assert.equal(after.title, "Renamed");
      assert.equal(after.subject, "Hello {{first_name|there}}");
      assert.equal(after.has_es, false);
      await saveEditorEmail(pool, T, id, { doc: d, snapshot: true }, "a");
      const v = await listVersions(pool, T, id);
      assert.equal(v.length, 2, "first save + leaving the editor");
      await assert.rejects(saveEditorEmail(pool, T, id, { doc: { nope: 1 } as never }, "a"), /Invalid email/);
    });

    await t("copy, and an HTML block's script never reaches the stored email", async () => {
      const id = await createEditorEmail(pool, T, null, { starter: "blank" });
      const e = (await getEditorEmail(pool, T, id))!;
      const d = structuredClone(e.doc);
      const h = newBlock("html");
      if (h.type === "html") h.code = '<p onclick="x()">hi</p><script>alert(1)</script>';
      d.sections[1].cols[0].blocks.push(h);
      await saveEditorEmail(pool, T, id, { doc: d }, null);
      const html = (await pool.query(`SELECT html FROM email_designs WHERE id = $1`, [id])).rows[0].html as string;
      assert.ok(!html.includes("<script") && !html.includes("onclick"));
      assert.equal(editorHtml(d), html);
      const copy = await createEditorEmail(pool, T, null, { fromId: id });
      assert.equal((await getEditorEmail(pool, T, copy))!.title, "New email (copy)");
    });

    await t("headline pictures end to end: drawn, stored once, put into the email; translations get their own", async () => {
      const { setPicStorageForTests, localizePics } = await import("../lib/server/email/text-pics");
      const { readyEditorPics } = await import("../lib/server/email/editor");
      const stored = new Map<string, number>();
      setPicStorageForTests(async (p) => (stored.set(p.path, p.bytes.length), { url: "", path: p.path }));
      const id = await createEditorEmail(pool, T, null, { starter: "drop" });
      const before = (await pool.query(`SELECT html FROM email_designs WHERE id = $1`, [id])).rows[0].html as string;
      assert.ok(!before.includes("pic-") && before.includes("NEW HEAT"), "saved at once with text standing in");
      await readyEditorPics(pool, id);
      const html = (await pool.query(`SELECT html FROM email_designs WHERE id = $1`, [id])).rows[0].html as string;
      const m = /<img src="[^"]*\/uploads\/pic-([0-9a-f]{16})\.png" alt="NEW HEAT"/.exec(html);
      assert.ok(m, "the headline is a picture in the stored email");
      assert.ok(stored.has(`email/uploads/pic-${m![1]}.png`) && stored.get(`email/uploads/pic-${m![1]}.png`)! > 500);
      const row = (await pool.query(`SELECT width, height FROM email_text_pics WHERE key = $1`, [m![1]])).rows[0];
      assert.ok(row.width > 400 && row.height > 40, JSON.stringify(row));
      // A second email with the same headline reuses the picture (nothing drawn again).
      const n0 = stored.size;
      const id2 = await createEditorEmail(pool, T, null, { starter: "drop" });
      assert.ok(((await pool.query(`SELECT html FROM email_designs WHERE id = $1`, [id2])).rows[0].html as string).includes(`pic-${m![1]}.png`));
      assert.equal(stored.size, n0);
      // Saving keeps the picture; translations draw the translated words.
      const e = (await getEditorEmail(pool, T, id))!;
      await saveEditorEmail(pool, T, id, { doc: e.doc }, null);
      assert.equal((await pool.query(`SELECT html FROM email_designs WHERE id = $1`, [id])).rows[0].html, html);
      const es = await localizePics(pool, e.doc, html, async (f) => f.replace("NEW HEAT", "NUEVO CALOR"), () => {});
      const mm = /<img src="[^"]*pic-([0-9a-f]{16})\.png" alt="NUEVO CALOR"/.exec(es);
      assert.ok(mm && mm[1] !== m![1], "Spanish copy has its own picture");
      assert.ok(!es.includes(`pic-${m![1]}.png`));
    });

    await t("templates and saved sections: saved as copies, new emails from a template, deleted ones gone", async () => {
      const { saveItem, listSaved, deleteItem, renameItem } = await import("../lib/server/email/library");
      const src = (await getEditorEmail(pool, T, await createEditorEmail(pool, T, null, { starter: "editorial" })))!;
      const tid = await saveItem(pool, T, "o@x", { kind: "template", name: "  Weekly arrivals  ", data: src.doc });
      const sec = src.doc.sections[1];
      const sid = await saveItem(pool, T, "o@x", { kind: "section", name: "Hero", data: sec });
      const all = await listSaved(pool, T);
      assert.deepEqual(all.map((x) => x.kind).sort(), ["section", "template"]);
      const savedSec = all.find((x) => x.id === sid)!.data as typeof sec;
      assert.notEqual(savedSec.id, sec.id, "a saved section never shares ids with the email it came from");
      assert.equal(JSON.stringify(savedSec.cols[0].blocks.map((b) => b.type)), JSON.stringify(sec.cols[0].blocks.map((b) => b.type)));
      const fromT = (await getEditorEmail(pool, T, await createEditorEmail(pool, T, null, { templateId: tid })))!;
      assert.equal(fromT.title, "Weekly arrivals");
      assert.equal(fromT.doc.sections.length, src.doc.sections.length);
      assert.notEqual(fromT.doc.sections[0].id, src.doc.sections[0].id);
      assert.deepEqual(fromT.doc.styles, src.doc.styles);
      await assert.rejects(saveItem(pool, T, null, { kind: "section", name: "x", data: { nope: 1 } }), /Invalid section/);
      await assert.rejects(saveItem(pool, T, null, { kind: "template", name: " ", data: src.doc }), /name/);
      assert.ok(await renameItem(pool, T, sid, "Store hero"));
      assert.equal((await listSaved(pool, T, "section"))[0].name, "Store hero");
      assert.ok(await deleteItem(pool, T, tid));
      assert.equal((await listSaved(pool, T, "template")).length, 0);
      await assert.rejects(createEditorEmail(pool, T, null, { templateId: tid }), /Template not found/);
      assert.equal((await listSaved(pool, "00000000-0000-0000-0000-000000000002")).length, 0, "another store sees nothing");
    });

    await t("brand kit: saved, checked, blank emails start with it, starters keep their own look", async () => {
      const { saveKit, getKit } = await import("../lib/server/email/library");
      assert.equal(await getKit(pool, T), null);
      const styles = structuredClone(defaultStyles());
      styles.pageBg = "#F7F4EF";
      styles.text.h1 = { ...styles.text.h1, family: "Bodoni Moda" };
      await saveKit(pool, T, "o@x", { styles, colors: ["#111111", "#f7f4ef", "#111111"] });
      const k = (await getKit(pool, T))!;
      assert.deepEqual(k.colors, ["#111111", "#F7F4EF"], "colours upper-cased, no repeats");
      await assert.rejects(saveKit(pool, T, null, { styles, colors: ["red"] }), /Invalid brand kit/);
      const blank = (await getEditorEmail(pool, T, await createEditorEmail(pool, T, null, { starter: "blank" })))!;
      assert.equal(blank.doc.styles.pageBg, "#F7F4EF");
      assert.equal(blank.doc.styles.text.h1.family, "Bodoni Moda");
      const drop = (await getEditorEmail(pool, T, await createEditorEmail(pool, T, null, { starter: "drop" })))!;
      assert.notEqual(drop.doc.styles.pageBg, "#F7F4EF", "a starter keeps its own look");
    });

    await t("AI (phase 3): plan → email, cleaned rewrites, the check's fixed rules", async () => {
      const { assembleEmail, cleanHtml, ruleIssues, words } = await import("../lib/server/email/editor-ai");
      const { renderEmail } = await import("../lib/email-editor/render");
      const prod = (ref: string, title: string, gender: "men" | "women" = "women") => ({
        ref, id: `gid://${ref}`, title, url: `https://shopcarbon.com/products/${ref}`, type: "Dress", gender, colors: ["Black"], sizes: ["S"], price: 49, compareAt: null, stock: 5, image: `https://cdn.example/${ref}.jpg`, handle: ref, setPartners: [],
      });
      const items = [prod("P1", "Mira Dress"), prod("P2", "Nova Top"), prod("P3", "Lux Skirt"), prod("P4", "Rio Tee", "men")];
      const plan = {
        title: "Weekend",
        subject: "Your weekend, sorted",
        preheader: "Three looks for Friday night",
        look: "dark",
        sections: [
          { id: "header", spots: {} },
          { id: "drop", spots: { T1: "FRIDAY · 9 PM", T2: "OUT <TONIGHT>", I1: "P1", B1: { text: "SHOP WOMEN", link: "women" } } },
          { id: "products-6", spots: { T1: "The edit", G1: ["P2", "P3", "NOPE"], B1: { text: "SEE IT ALL", link: "P4" } } },
          { id: "nonsense", spots: {} },
          { id: "follow", spots: { T1: "should be ignored" } },
        ],
      };
      const b = assembleEmail(plan, items as never, [], null);
      assert.equal(b.subject, "Your weekend, sorted");
      assert.ok(isDoc(b.doc));
      assert.equal(b.doc.styles.pageBg, "#0E0E0E", "dark look");
      const blocks = b.doc.sections.flatMap((s) => s.cols.flatMap((c) => c.blocks));
      const header = blocks.find((x) => x.type === "header");
      assert.ok(header?.type === "header" && /white/.test(header.logo ?? ""), "dark look uses the white-logo header");
      const texts = blocks.filter((x) => x.type === "text").map((x) => (x.type === "text" ? x.html : ""));
      assert.ok(texts.some((h) => h.includes("OUT &lt;TONIGHT&gt;") && h.includes("Bebas Neue")), "headline words escaped, style kept");
      assert.ok(!texts.some((h) => h.includes("should be ignored")), "fixed sections keep their words");
      const img = blocks.find((x) => x.type === "image" && x.src);
      assert.ok(img?.type === "image" && img.src === "https://cdn.example/P1.jpg" && img.href.endsWith("/P1") && img.alt === "Mira Dress");
      const grid = blocks.find((x) => x.type === "product");
      assert.ok(grid?.type === "product" && grid.source === "static" && grid.items.map((i) => i.title).join() === "Nova Top,Lux Skirt", "unknown refs dropped");
      const btns = blocks.filter((x) => x.type === "button").map((x) => (x.type === "button" ? `${x.text}>${x.href}` : ""));
      assert.ok(btns.includes("SHOP WOMEN>https://shopcarbon.com/collections/women") && btns.includes("SEE IT ALL>https://shopcarbon.com/products/P4"));
      assert.ok(!renderEmail(b.doc).includes("Drop an image here"));
      assert.throws(() => assembleEmail({ sections: [{ id: "x" }] }, items as never, [], null), /could not be used/);

      assert.equal(cleanHtml(`<p onclick="x()">Hi <img src=x onerror=1><a href="javascript:alert(1)">go</a><script>bad()</script></p>`), `<p>Hi <a href="#">go</a></p>`);
      assert.equal(words(`<h1>A &amp; B</h1><p>one<br>two</p>`), "A & B\none\ntwo");

      const d = STARTERS.find((x) => x.id === "collection")!.make();
      const issues = ruleIssues(d, "", "");
      assert.ok(issues.some((i) => i.blockId === null && /no subject/.test(i.text)));
      assert.ok(issues.some((i) => /picture spot is empty/.test(i.text)), "empty hero photo found");
      assert.ok(issues.some((i) => /example wording/.test(i.text)), "starter wording found");
      const fixed = structuredClone(d);
      for (const s of fixed.sections) for (const c of s.cols) for (const x of c.blocks) if (x.type === "text") x.html = `<p>Hello {{nickname}}</p>`;
      assert.ok(ruleIssues(fixed, "Hi", "There").some((i) => /Unknown personal tag \{\{nickname\}\}/.test(i.text)));
    });

    await t("CARBON pack hero: drawn once as a 1200 px JPG, stored, put into the email", async () => {
      const { setPicStorageForTests, ensureDocPics } = await import("../lib/server/email/text-pics");
      const { PACK } = await import("../lib/email-editor/pack");
      const sharp = (await import("sharp")).default;
      const stored = new Map<string, Buffer>();
      setPicStorageForTests(async (p) => (stored.set(p.path, Buffer.from(p.bytes)), { url: "", path: p.path }));
      const d = PACK.find((x) => x.id === "pack-red-alert")!.make();
      const pics = await ensureDocPics(pool, d, () => {});
      const keys = Object.keys(pics);
      assert.ok(keys.length >= 1);
      const heroPath = [...stored.keys()].find((k) => k.endsWith(".jpg"))!;
      assert.ok(heroPath, "a .jpg was stored");
      const meta = await sharp(stored.get(heroPath)!).metadata();
      assert.equal(meta.format, "jpeg");
      assert.equal(meta.width, 1200);
      assert.equal(meta.height, 1200);
      assert.ok(stored.get(heroPath)!.length < 400_000, `hero ${stored.get(heroPath)!.length} bytes`);
      const { renderEmail } = await import("../lib/email-editor/render");
      const html = renderEmail(d, pics);
      assert.ok(/pic-[0-9a-f]{16}\.jpg" alt="DROP ALERT/.test(html), "the email shows the hero picture with its words as alt text");
    });

    await t("personal hero (member card): kept as a page, drawn once per name, shared by everyone with that name", async () => {
      const { setPicStorageForTests, ensureDocPics, personalHero, cleanName } = await import("../lib/server/email/text-pics");
      const { renderEmail } = await import("../lib/email-editor/render");
      const { PACK_MORE } = await import("../lib/email-editor/pack");
      const stored = new Map<string, number>();
      setPicStorageForTests(async (p) => (stored.set(p.path, p.bytes.length), { url: "", path: p.path }));
      const d = PACK_MORE.find((x) => x.id === "pack-38-glass")!.make();
      const html = renderEmail(d);
      const m = /api\/public\/email\/hero\/([0-9a-f]{16})\.jpg\?n=\{\{first_name\|\}\}/.exec(html);
      assert.ok(m, "the email asks for the person's own picture");
      await ensureDocPics(pool, d, () => {});
      assert.equal((await pool.query(`SELECT count(*)::int n FROM email_hero_pages WHERE key = $1`, [m![1]])).rows[0].n, 1);
      assert.equal(cleanName("  maría <b>josé</b>!! "), "MARÍA BJOSÉB");
      const a = await personalHero(pool, m![1], "Ana", () => {});
      const b = await personalHero(pool, m![1], "ana", () => {});
      assert.ok(a && a === b, "the same name is drawn once");
      assert.equal([...stored.keys()].filter((k) => k.endsWith(".jpg")).length, 1);
      assert.equal(await personalHero(pool, "0000000000000000", "Ana", () => {}), null, "unknown hero");
    });

    await t("phase 5: segments, A/B split and winner, birthday flow, report", async () => {
      const { audienceCount } = await import("../lib/server/email/contacts");
      const { saveSegment, listSegments, segmentCount } = await import("../lib/server/email/segments");
      const C = await import("../lib/server/email/campaigns");
      const F = await import("../lib/server/email/flows");
      const { emailReport } = await import("../lib/server/email/reports");
      const add = (email: string, extra = "") =>
        pool.query(`INSERT INTO email_contacts (tenant_id, email, first_name, unsub_token, in_rewards, birthday) VALUES ($1::uuid, $2, 'X', md5($2), ${extra || "false, NULL"}) ON CONFLICT DO NOTHING`, [T, email]);
      await pool.query(`DELETE FROM email_orders_seen`);
      for (let i = 0; i < 30; i++) await add(`p${i}@x.com`);
      await add("vip@x.com", "true, (now() AT TIME ZONE 'America/New_York')::date - interval '30 years'");
      const order = (email: string, id: string, total: number, daysAgo: number) =>
        pool.query(`INSERT INTO email_orders_seen (source, order_id, tenant_id, email, total, processed_at) VALUES ('shopify', $1, $2::uuid, $3, $4, now() - make_interval(days => $5::int))`, [id, T, email, total, daysAgo]);
      await order("vip@x.com", "o1", 150, 10);
      await order("vip@x.com", "o2", 200, 40);
      await order("vip@x.com", "o3", 90, 100);
      await order("p1@x.com", "o4", 60, 200);
      assert.equal(await segmentCount(pool, T, [{ k: "ordered", min: 3, days: 365 }]), 1, "3+ orders in a year");
      assert.equal(await segmentCount(pool, T, [{ k: "spent", min: 300, days: 365 }]), 1);
      assert.equal(await segmentCount(pool, T, [{ k: "no_order", days: 180 }]), 1, "p1 lapsed");
      assert.equal(await segmentCount(pool, T, [{ k: "rewards", yes: true }, { k: "birthday", month: "this" }]), 1);
      const neverBefore = await segmentCount(pool, T, [{ k: "never_ordered" }]);
      assert.ok(neverBefore >= 29);
      const sid = await saveSegment(pool, T, "o@x", { name: "Best", rules: [{ k: "ordered", min: 3, days: 365 }] });
      assert.equal((await listSegments(pool, T)).find((x) => x.id === sid)?.count, 1);
      await assert.rejects(saveSegment(pool, T, null, { name: "Bad", rules: [{ k: "ordered", min: 0, days: 1 }] }), /Add at least one rule/);
      assert.equal(await audienceCount(pool, T, { who: "all", segment: { id: sid, name: "Best", rules: [{ k: "ordered", min: 3, days: 365 }] } }), 1);

      // A/B: 20% test split half and half, the rest waits; the winner is the better open rate
      assert.equal(C.parseAb({ subjectB: "B!", testPct: 5, hours: 4, metric: "opens" }), "invalid");
      const camp = (await pool.query<{ id: string }>(`INSERT INTO email_campaigns (tenant_id, name, subject, audience, ab, status) VALUES ($1::uuid, 'AB', 'A!', '{"who":"all"}', $2, 'sending') RETURNING id::text`, [T, JSON.stringify({ subjectB: "B!", testPct: 20, hours: 4, metric: "opens" })])).rows[0].id;
      await C.snapshotRecipients(pool, T, camp, { who: "all" });
      await pool.query(`WITH r AS (SELECT id, row_number() OVER (ORDER BY id) rn FROM email_campaign_recipients WHERE campaign_id = $1::uuid) UPDATE email_campaign_recipients x SET variant = CASE WHEN rn <= 3 THEN 'A' WHEN rn <= 6 THEN 'B' ELSE 'W' END FROM r WHERE x.id = r.id`, [camp]);
      await pool.query(`UPDATE email_campaign_recipients SET status = 'sent', sent_at = now() - interval '5 hours' WHERE campaign_id = $1::uuid AND variant IN ('A','B')`, [camp]);
      await pool.query(`UPDATE email_campaign_recipients SET opened_at = now() WHERE campaign_id = $1::uuid AND variant = 'B'`, [camp]);
      assert.equal(await C.decideAbWinners(pool, () => {}), 0, "first: the test is marked done");
      await pool.query(`UPDATE email_campaigns SET ab = ab || '{"testDoneAt":"2020-01-01T00:00:00Z"}' WHERE id = $1::uuid`, [camp]);
      assert.equal(await C.decideAbWinners(pool, () => {}), 1);
      const ab = (await pool.query(`SELECT ab FROM email_campaigns WHERE id = $1::uuid`, [camp])).rows[0].ab;
      assert.equal(ab.winner, "B");
      const st = await C.abStats(pool, camp);
      assert.equal(st.A.sent, 3);
      assert.ok(st.W.waiting >= 25);

      // birthday flow: today's birthdays enter once a year
      const fid = await F.createFlow(pool, T, "o@x", "birthday");
      const f = await F.setFlowStatus(pool, T, fid, "live");
      assert.equal(f.trigger.type, "birthday");
      await pool.query(`UPDATE email_flows SET live_since = now() - interval '1 minute' WHERE id = $1::uuid`, [fid]);
      await pool.query(`DELETE FROM email_flow_state WHERE key = 'polled_at'`);
      F.setFlowDepsForTests({ send: async () => "mid", code: async () => ({ code: "C", gid: "g" }), pacing: async () => ({ perMinute: 60, leftToday: 100 }) });
      await F.pollTriggers(pool, T, () => {}, true);
      const runs = await pool.query(`SELECT email FROM email_flow_runs WHERE flow_id = $1::uuid`, [fid]);
      assert.deepEqual(runs.rows.map((r) => r.email), ["vip@x.com"]);
      await F.pollTriggers(pool, T, () => {}, true);
      assert.equal((await pool.query(`SELECT count(*)::int n FROM email_flow_runs WHERE flow_id = $1::uuid`, [fid])).rows[0].n, 1, "once a year");

      const rep = await emailReport(pool, T, 30);
      assert.ok(rep.totals.sent >= 6);
      assert.ok(rep.rows.some((r) => r.kind === "campaign" && r.name === "AB"));
      await F.archiveFlow(pool, T, fid);
      await pool.query(`DELETE FROM email_orders_seen`);
    });

    await t("flows: ready-made flow → live → person waits, gets their own cart, leaves when they order; events and stats", async () => {
      const F = await import("../lib/server/email/flows");
      const { inWindow, flowProblems, FLOW_IDEAS } = await import("../lib/email-editor/flows");
      const { applyEvent } = await import("../lib/server/email/campaigns");
      const sent: { to: string; subject: string; html: string; tags: { name: string; value: string }[] }[] = [];
      let codes = 0;
      F.setFlowDepsForTests({
        send: async (_s, m) => (sent.push(m), `mid-${sent.length}`),
        code: async () => ({ code: `CARBON-T${++codes}`, gid: `gid://shopify/DiscountCodeNode/${codes}` }),
        pacing: async () => ({ perMinute: 60, leftToday: 1000 }),
      });
      await pool.query(`INSERT INTO email_settings (tenant_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING`, [T]);

      // the send window (Orlando): 3 AM waits for 9 AM, noon goes at once
      const night = new Date("2026-11-10T08:00:00Z"); // 3 AM EST
      assert.equal(inWindow(night, { sendFrom: 9, sendTo: 21 }).toISOString(), "2026-11-10T14:00:00.000Z");
      const noon = new Date("2026-11-10T17:00:00Z");
      assert.equal(inWindow(noon, { sendFrom: 9, sendTo: 21 }).getTime(), noon.getTime());

      for (const idea of FLOW_IDEAS) assert.deepEqual(flowProblems({ ...idea.make(), steps: idea.make().steps.map((x) => (x.type === "email" ? { ...x, designId: "d" } : x)) }), [], idea.kind);

      const id = await F.createFlow(pool, T, "o@x", "abandoned");
      let f = (await F.getFlow(pool, T, id))!;
      const emailSteps = f.steps.filter((x) => x.type === "email");
      assert.equal(emailSteps.length, 2);
      assert.ok(emailSteps.every((x) => x.type === "email" && x.designId), "its emails were made from the starters");
      await assert.rejects(F.saveFlow(pool, T, id, { steps: [{ id: "x", type: "wait", amount: -1, unit: "days" }] }), /Invalid steps/);
      await assert.rejects(F.saveFlow(pool, T, id, { settings: { ...f.settings, sendFrom: 22, sendTo: 9 } }), /Invalid settings/);

      // nothing before "Turn on" counts
      const item = { id: "i1", title: "Mira Dress", price: 49, compareAt: null, image: "https://cdn.example/mira.jpg", url: "https://shopcarbon.com/products/mira", set: null };
      const person = (key: string, at: Date) => ({ email: "ana@example.com", firstName: "Ana", key, at, data: { items: [item], checkoutUrl: "https://shopcarbon.com/123/checkouts/ac/abc/recover?key=k&x=1" } });
      assert.equal(await F.enroll(pool, f, person("checkout:old", new Date())), false, "draft: nobody enters");
      f = await F.setFlowStatus(pool, T, id, "live");
      assert.equal(await F.enroll(pool, f, person("checkout:old", new Date(Date.now() - 3_600_000))), false, "before it was turned on");
      assert.equal(await F.enroll(pool, f, person("checkout:1", new Date(Date.now() + 1000))), true);
      assert.equal(await F.enroll(pool, f, person("checkout:1", new Date(Date.now() + 1000))), false, "same checkout twice");
      assert.equal(await F.enroll(pool, f, person("checkout:2", new Date(Date.now() + 1000))), false, "re-entry only after 7 days");

      const at = (h: number) => () => new Date(new Date("2026-11-10T17:00:00Z").getTime() + h * 3_600_000); // noon in Orlando + h
      await pool.query(`UPDATE email_flow_runs SET next_at = $1, started_at = $1 WHERE flow_id = $2::uuid`, [at(0)(), id]);
      let r = await F.runFlowSteps(pool, () => {}, at(0));
      assert.equal(r.sent, 0, "first step is the 1 hour wait");
      r = await F.runFlowSteps(pool, () => {}, at(0.5));
      assert.equal(r.sent, 0, "not yet");
      r = await F.runFlowSteps(pool, () => {}, at(1.01));
      assert.equal(r.sent, 1, "the cart email");
      const m = sent[0];
      assert.equal(m.to, "ana@example.com");
      assert.equal(m.subject, "You left something behind");
      assert.ok(m.html.includes("https://cdn.example/mira.jpg") && m.html.includes("Mira Dress"), "their own cart");
      assert.ok(m.html.includes('href="https://shopcarbon.com/123/checkouts/ac/abc/recover?key=k&amp;x=1"'), "the button goes back to their checkout");
      assert.ok(/unsubscribe/i.test(m.html), "footer with unsubscribe");
      assert.ok(!m.html.includes("{{"), "every personal tag filled");
      assert.deepEqual(m.tags[0], { name: "flow", value: id });

      // SES events reach the flow email
      await applyEvent(pool, "sns-1", { eventType: "Open", mail: { messageId: "mid-1", destination: ["ana@example.com"] }, open: { timestamp: new Date().toISOString() } } as never);
      // a night-time due email waits for 9 AM
      r = await F.runFlowSteps(pool, () => {}, at(1.02 + 24 + 10)); // a day later, 10 PM+: outside the window
      assert.equal(r.sent, 0);
      const waiting = await pool.query(`SELECT next_at FROM email_flow_runs WHERE flow_id = $1::uuid`, [id]);
      assert.equal(Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(waiting.rows[0].next_at)), 9);

      // she orders: the flow stops at the next "stop if they ordered"
      await pool.query(`INSERT INTO email_orders_seen (source, order_id, tenant_id, email, total, processed_at) VALUES ('shopify', 'o1', $1::uuid, 'ana@example.com', 120, $2)`, [T, at(30)()]);
      r = await F.runFlowSteps(pool, () => {}, at(48));
      assert.equal(r.sent, 0);
      assert.equal(r.exited, 1);
      const run = await pool.query(`SELECT status, exit_reason FROM email_flow_runs WHERE flow_id = $1::uuid`, [id]);
      assert.deepEqual(run.rows[0], { status: "exited", exit_reason: "Placed an order" });

      const st = (await F.flowStats(pool, [id])).get(id)!;
      assert.equal(st.sent, 1);
      assert.equal(st.opened, 1);
      assert.equal(st.orders, 1, "she ordered within 5 days of the email: it counts for the flow");
      assert.equal(st.revenue, 120);
    });
  } finally {
    await pool.end();
  }
  console.log(`\n${n} groups passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
