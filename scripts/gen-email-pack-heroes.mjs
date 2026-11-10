#!/usr/bin/env node
/**
 * One-time converter for the owner's CARBON email pack (2026-11-10, CARBON-Email-Pack.html → unpacked
 * folder): turns hero-templates/11…70.html into lib/email-editor/pack-heroes.data.ts, the editable
 * hero layouts used by the "Hero picture" block.
 *
 *   node scripts/gen-email-pack-heroes.mjs <unpacked carbon-email-pack folder>
 *
 * For each hero file:
 *   - its <style> is kept, with fonts and elements pointed at https://wms.shopcarbon.com/email/pack/
 *     (the placeholder text wordmark becomes the real CARBON logo);
 *   - every photo spot (.ph placeholder figure, .cut cut-out figure) becomes a photo slot;
 *   - every visible word becomes a text slot (the same words repeated, e.g. BLACK FRIDAY ×5, are one slot);
 *   - the "PHOTO: …" guide labels are kept but only shown while a slot has no photo;
 *   - the pack's fit script is replaced by heroes.ts's (it waits for the fonts properly).
 * Templates 01–10 keep their hand-built layouts in heroes.ts.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/gen-email-pack-heroes.mjs <carbon-email-pack folder>");
const BASE = "https://wms.shopcarbon.com/email";
const cal = JSON.parse(readFileSync(join(dir, "seasonal-calendar.json"), "utf8"));
const STUDIO_ACCENT = { 31: "#FF4D00", 32: "#FF4D00", 33: "#FF4D00", 34: "#00E5FF", 35: "#E10600", 36: "#FF4D00", 37: "#00A99D", 38: "#FF4D00", 39: "#FF4D00", 40: "#E10600" };

const decode = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&rarr;/g, "→")
    .replace(/&middot;/g, "·")
    .replace(/&times;/g, "×")
    .replace(/&bull;/g, "•");

const out = [];
for (const file of readdirSync(join(dir, "hero-templates")).sort()) {
  const n = parseInt(file, 10);
  if (!(n >= 11 && n <= 70)) continue;
  const id = file.replace(/\.html$/, "");
  let src = readFileSync(join(dir, "hero-templates", file), "utf8");
  const ref = readFileSync(join(dir, "reference-html", file), "utf8");
  const name = (/<title>([^<]*)/.exec(ref)?.[1] ?? id).replace(/^CARBON — /, "");
  const css = (/<style>([\s\S]*?)<\/style>/.exec(src)?.[1] ?? "")
    .replace(/url\(\.\.\/assets\/fonts\/([a-z0-9-]+)\.woff2\)/g, `url(${BASE}/pack/fonts/$1.woff2)`)
    .replace(/body\{background:#222;padding:0\}/, "body{background:transparent;padding:0}");
  let body = /<body>([\s\S]*?)<script|<body>([\s\S]*?)<\/body>/.exec(src);
  body = (body?.[1] ?? body?.[2] ?? "").trim();
  const height = Number(/id="hero"[^>]*height:(\d+)px/.exec(body)?.[1] ?? 700);
  body = body
    .replace(/\.\.\/assets\/elements\/wordmark-bone\.png/g, `${BASE}/carbon-logo-long-white.png`)
    .replace(/\.\.\/assets\/elements\/wordmark-ink\.png/g, `${BASE}/carbon-logo-long-black.png`)
    .replace(/\.\.\/assets\/elements\/([a-z0-9-]+\.png)/g, `${BASE}/pack/$1`);

  // photo slots
  const photos = [];
  body = body.replace(/<div class="ph[^"]*" style="([^"]*)">\s*<div class="fig"[^>]*>(?:<i[^>]*><\/i>)*<\/div>\s*(?:<span class="tag"[^>]*>[^<]*<\/span>\s*)?<\/div>/g, (whole, style) => {
    photos.push({ kind: "ph", style, orig: whole });
    return `\u0001P${photos.length - 1}\u0001`;
  });
  body = body.replace(/<div class="cut" style="([^"]*)">(?:<i[^>]*><\/i>)*<\/div>/g, (whole, style) => {
    photos.push({ kind: "cut", style, orig: whole });
    return `\u0001P${photos.length - 1}\u0001`;
  });
  // guide labels ("PHOTO: …")
  body = body.replace(/<span class="tag"/g, '<span class="tag guide"');

  // text slots: visible words outside <svg>, <script>, <style> and the guide labels
  const texts = [];
  const keyOf = new Map();
  let depthSvg = 0;
  let inGuide = false;
  let lastTag = "";
  body = body.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, txt) => {
    if (tag) {
      if (/^<svg\b/i.test(tag)) depthSvg++;
      else if (/^<\/svg>/i.test(tag)) depthSvg--;
      if (/class="tag guide"/.test(tag)) inGuide = true;
      else if (inGuide && /^<\/span>/.test(tag)) inGuide = false;
      lastTag = (/^<\/?([a-zA-Z]+)/.exec(tag)?.[1] ?? "").toLowerCase() + (tag.startsWith("</") ? "/" : "");
      return tag;
    }
    // Inside a drawing only the words of <text>/<textPath> (e.g. type around a circle) are editable.
    const svgWords = depthSvg > 0 && ["text", "textpath", "tspan"].includes(lastTag);
    if ((depthSvg > 0 && !svgWords) || inGuide || !/[A-Za-z0-9]/.test(txt) || txt.includes("\u0001")) return txt;
    const lead = /^\s*/.exec(txt)[0];
    const trail = /\s*$/.exec(txt)[0];
    const def = decode(txt.trim());
    let k = keyOf.get(def);
    if (k === undefined) {
      k = texts.length;
      keyOf.set(def, k);
      // A hero is one picture for everyone: no personal tags in it.
      texts.push(def === "{{FIRST_NAME}}" ? "MEMBER NAME" : def.replace(/\{\{\s*first_name\s*\}\}/gi, "FRIEND").replace(/\{\{[^}]*\}\}/g, "").replace(/\{\{[A-Z_]*$/, "FRIEND"));
    }
    return `${lead}\u0001T${k}\u0001${trail}`;
  });
  // Bright series (41–70): the first bright colour the hero uses is its accent.
  const BRIGHT = ["#C6FF00", "#FF3EA5", "#FFD400", "#FF7A00", "#7FD6FF", "#6EF2C2", "#C9A7FF", "#FF3B30", "#2D46FF", "#00A99D", "#E9D9B8"];
  const brightAccent = n >= 41 ? BRIGHT.map((c) => [c, body.toUpperCase().indexOf(c)]).filter((x) => x[1] >= 0).sort((a, b) => a[1] - b[1])[0]?.[0] : null;
  const accent = (cal.find((c) => c.id === id)?.accent ?? STUDIO_ACCENT[n] ?? brightAccent ?? "#FF4D00").toUpperCase();
  out.push({ id, n, name, height, accent, css, body, texts, photos: photos.map((p) => ({ kind: p.kind, style: p.style, orig: p.orig })) });
}

const banner = `/* eslint-disable */\n// GENERATED by scripts/gen-email-pack-heroes.mjs from the owner's CARBON email pack (2026-11-10). Do not edit by hand.\n`;
writeFileSync(
  "lib/email-editor/pack-heroes.data.ts",
  `${banner}export type PackHeroSource = { id: string; n: number; name: string; height: number; accent: string; css: string; body: string; texts: string[]; photos: { kind: "ph" | "cut"; style: string; orig: string }[] };\nexport const PACK_HEROES: PackHeroSource[] = JSON.parse(${JSON.stringify(JSON.stringify(out))});\n`,
);
console.log(out.map((h) => `${h.id}: ${h.texts.length} texts, ${h.photos.length} photos, h ${h.height}, ${h.accent}`).join("\n"));
