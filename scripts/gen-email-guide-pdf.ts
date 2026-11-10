/**
 * Makes the Email Marketing guide PDF from lib/email-editor/guide.ts (the same text as the Guide panel).
 *
 *   npx tsx scripts/gen-email-guide-pdf.ts
 *
 * Writes public/email/guide/CarbonWMS-Email-Marketing-Guide.pdf (opened by the Guide panel's PDF button;
 * behind the CarbonWMS login like every other page). Run it again whenever guide.ts changes.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
import { GUIDE, GUIDE_UPDATED, type GuideBlock } from "../lib/email-editor/guide";

const OUT = "public/email/guide/CarbonWMS-Email-Marketing-Guide.pdf";
const logo = `data:image/png;base64,${readFileSync("public/email/carbon-logo-long-black.png").toString("base64")}`;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const rich = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

function block(b: GuideBlock): string {
  switch (b.t) {
    case "p":
      return `<p>${rich(b.text)}</p>`;
    case "steps":
      return `<ol class="steps">${b.items.map((x) => `<li>${rich(x)}</li>`).join("")}</ol>`;
    case "list":
      return `<ul>${b.items.map((x) => `<li>${rich(x)}</li>`).join("")}</ul>`;
    case "ai":
    case "tip":
    case "warn":
      return `<div class="call ${b.t}"><b>${b.t === "ai" ? "AI" : b.t === "tip" ? "Tip" : "Careful"}:</b> ${rich(b.text)}</div>`;
    case "table":
      return `<table><thead><tr>${b.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${b.rows
        .map((r) => `<tr>${r.map((c) => `<td>${rich(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`;
    case "map":
      return `<figure class="map"><div class="svg">${b.svg}</div><ol class="legend">${b.legend
        .map((x, i) => `<li><span class="n">${i + 1}</span><span>${rich(x)}</span></li>`)
        .join("")}</ol></figure>`;
  }
}

const body = GUIDE.map(
  (s, i) => `<section id="${s.id}"${i > 0 ? ' class="newpage"' : ""}>
  <h2><span class="num">${i + 1}</span>${esc(s.title)}</h2>
  ${s.intro ? `<p class="intro">${rich(s.intro)}</p>` : ""}
  ${s.parts.map((p) => `${p.title ? `<h3>${esc(p.title)}</h3>` : ""}${p.blocks.map(block).join("")}`).join("")}
</section>`,
).join("");

const html = `<!doctype html><html><head><meta charset="utf-8"><title>CarbonWMS Email Marketing guide</title><style>
@page { size: Letter; margin: 18mm 16mm 18mm 16mm; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; font-size: 10.5pt; line-height: 1.5; margin: 0; }
.cover { height: 235mm; display: flex; flex-direction: column; justify-content: space-between; }
.cover img { width: 210px; }
.cover h1 { font-size: 34pt; line-height: 1.05; margin: 0 0 10px; letter-spacing: -0.5px; }
.cover .sub { font-size: 13pt; color: #444; max-width: 140mm; }
.cover .meta { font-size: 9.5pt; color: #666; border-top: 1px solid #ddd; padding-top: 8px; }
.toc { page-break-before: always; }
.toc h2 { font-size: 18pt; margin: 0 0 12px; }
.toc ol { padding: 0; list-style: none; margin: 0; }
.toc li { display: flex; gap: 10px; padding: 7px 0; border-bottom: 1px solid #eee; font-size: 11.5pt; }
.toc li span:first-child { width: 22px; color: #E11D48; font-weight: 700; }
.toc a { color: #111; text-decoration: none; }
.newpage, section:first-of-type { page-break-before: always; }
h2 { font-size: 18pt; margin: 0 0 6px; display: flex; align-items: center; gap: 10px; }
h2 .num { display: inline-flex; width: 28px; height: 28px; border-radius: 50%; background: #111; color: #fff; font-size: 12pt; align-items: center; justify-content: center; }
h3 { font-size: 12.5pt; margin: 16px 0 6px; page-break-after: avoid; }
.intro { color: #444; font-size: 11pt; }
p { margin: 6px 0; }
ul, ol { margin: 6px 0 6px 20px; padding: 0; }
li { margin: 3px 0; }
ol.steps li::marker { font-weight: 700; }
table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 9.5pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { text-align: left; background: #f2f2f2; padding: 5px 7px; border-bottom: 1px solid #ccc; }
td { padding: 5px 7px; border-bottom: 1px solid #e5e5e5; vertical-align: top; }
.call { border-left: 4px solid; padding: 6px 10px; margin: 8px 0; border-radius: 3px; page-break-inside: avoid; }
.call.ai { border-color: #7C3AED; background: #F5F3FF; }
.call.tip { border-color: #0284C7; background: #F0F9FF; }
.call.warn { border-color: #D97706; background: #FFFBEB; }
figure.map { margin: 8px 0; page-break-inside: avoid; }
figure.map .svg { border: 1px solid #ddd; border-radius: 6px; padding: 6px; color: #111; }
.legend { list-style: none; margin: 8px 0 0; padding: 0; font-size: 9.5pt; }
.legend li { display: flex; gap: 8px; margin: 4px 0; }
.legend .n { flex: none; width: 17px; height: 17px; border-radius: 50%; background: #E11D48; color: #fff; font-size: 8pt; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
</style></head><body>
<div class="cover">
  <div><img src="${logo}" alt="CARBON"></div>
  <div>
    <h1>Email Marketing<br>guide</h1>
    <div class="sub">How to create, change and send emails in CarbonWMS: every tab, where the AI is, and what each button does.</div>
  </div>
  <div class="meta">CarbonWMS · wms.shopcarbon.com/marketing/email · Updated ${GUIDE_UPDATED}<br>The same guide is inside CarbonWMS: Email Marketing → <b>Guide</b> (top right of the tabs).</div>
</div>
<div class="toc"><h2>Contents</h2><ol>${GUIDE.map((s, i) => `<li><span>${i + 1}</span><a href="#${s.id}">${esc(s.title)}</a></li>`).join("")}</ol></div>
${body}
</body></html>`;

async function main() {
  mkdirSync("public/email/guide", { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({
    path: OUT,
    format: "Letter",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate:
      '<div style="width:100%;font-size:8px;color:#888;padding:0 16mm;display:flex;justify-content:space-between;font-family:Helvetica,Arial"><span>CARBON · CarbonWMS Email Marketing guide</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margin: { top: "16mm", bottom: "18mm", left: "16mm", right: "16mm" },
  });
  await browser.close();
  console.log("wrote", OUT);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
