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
      for (const f of ["0147_email_campaigns.sql", "0148_email_design_products.sql", "0149_email_brand_media.sql", "0150_email_layout_engine.sql", "0151_email_picture_review.sql", "0152_email_six_steps.sql", "0153_email_translations.sql", "0154_email_styles.sql", "0155_email_editor.sql", "0156_email_text_pics.sql", "0157_email_library.sql"])
        await pool.query(readFileSync(`scripts/migrations/${f}`, "utf8"));
    console.log("ok  migrations (with 0155–0157) apply twice");

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
  } finally {
    await pool.end();
  }
  console.log(`\n${n} groups passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
