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
      for (const f of ["0147_email_campaigns.sql", "0148_email_design_products.sql", "0149_email_brand_media.sql", "0150_email_layout_engine.sql", "0151_email_picture_review.sql", "0152_email_six_steps.sql", "0153_email_translations.sql", "0154_email_styles.sql", "0155_email_editor.sql"])
        await pool.query(readFileSync(`scripts/migrations/${f}`, "utf8"));
    console.log("ok  migrations (with 0155) apply twice");

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
  } finally {
    await pool.end();
  }
  console.log(`\n${n} groups passed`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
