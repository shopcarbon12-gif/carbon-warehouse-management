#!/usr/bin/env node
/**
 * One-time converter for the owner's CARBON email pack (2026-11-10): turns reference-html/11…70.html
 * into lib/email-editor/pack-emails.data.ts — one plan per email, row by row, which pack.ts builds
 * into normal editor blocks (logo bar, hero picture, text, button, products, picture, split, footer).
 *
 *   node scripts/gen-email-pack-emails.mjs <unpacked carbon-email-pack folder>
 *
 * Rows that are not one of those (specs, steps, promo codes, quotes, tickers, star ratings …) become
 * text blocks holding the pack's own HTML, so every word stays editable in the editor.
 * The owner's rules are applied to the copy: "CARBON" never "CARBON Jeans", no country of origin,
 * links and personal tags mapped to what CarbonWMS has (see TAGS below).
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node scripts/gen-email-pack-emails.mjs <carbon-email-pack folder>");
const prompt = readFileSync(join(dir, "PROMPT.md"), "utf8");
const BASE = "https://wms.shopcarbon.com/email";
const SHOP = "https://shopcarbon.com";

/** Pack tags → CarbonWMS ({{…}} that CarbonWMS fills) or a plain link / editable words. */
const TAGS = {
  first_name: "{{first_name|there}}",
  FIRST_NAME: "{{first_name|there}}",
  shop_url: "{{shop_url}}",
  instagram_url: "{{instagram_url}}",
  unsubscribe_url: "{{unsubscribe_url}}",
  preferences_url: "{{unsubscribe_url}}",
  campaign_url: SHOP,
  product_url: `${SHOP}/collections/new-arrivals`,
  rewards_url: `${SHOP}/pages/member-club`,
  notify_url: "{{instagram_url}}",
  maps_url: "https://www.google.com/maps/dir/?api=1&destination=6250+Edgewater+Drive%2C+Suite+100%2C+Orlando%2C+FL+32810",
  store_address: "6250 Edgewater Drive, Suite 100, Orlando, FL 32810",
  store_hours: "Mon–Tue 12–7 PM · Thu–Sat 12–7 PM · Wed &amp; Sun closed",
  event_address: "6250 Edgewater Drive, Suite 100, Orlando, FL 32810",
  asset_base: `${BASE}/pack`,
  cart_url: "{{checkout_url}}",
  order_number: "{{order_name}}",
  order_url: SHOP,
  tracking_url: "{{tracking_url}}",
  review_url: SHOP,
  referral_url: SHOP,
  giftcard_url: SHOP,
  wishlist_url: SHOP,
  about_url: `${SHOP}/pages/about-us`,
  fit_quiz_url: SHOP,
  care_url: SHOP,
  sms_url: SHOP,
  survey_url: SHOP,
  giveaway_url: "{{instagram_url}}",
  calendar_url: SHOP,
  birthday_code: "{{code}}",
  referral_code: "{{code}}",
  cart_total: "",
  size: "your size",
  carrier: "the carrier",
  delivery_date: "in a few days",
  partner: "PARTNER",
  years: "10",
  event_date: "NOV 21",
  event_time: "7:00 PM",
};

const fixCopy = (h) =>
  h
    // a few labels in the pack are cut short ("{{FIRST_N"): finish them
    .replace(/\{\{FIRST_N(?:A|AM|AME)?(?=[^A-Za-z_}]|$)/g, "{{FIRST_NAME}}")
    .replace(/CARBON Jeans/g, "CARBON")
    .replace(/Carbon Jeans/g, "CARBON")
    .replace(/\bJapanese\s+/gi, "")
    .replace(/\{\{#items\}\}[\s\S]*?\{\{\/items\}\}/g, "")
    // the pack's note about a live timer image (CarbonWMS keeps the static cells)
    .replace(/<(div|td|p)\b[^>]*>[^<]*\{\{countdown_gif_url\}\}[^<]*<\/\1>/g, "")
    .replace(/\{\{\s*([A-Za-z_]+)\s*\}\}/g, (m, t) => (t in TAGS ? TAGS[t] : t.toLowerCase() in TAGS ? TAGS[t.toLowerCase()] : m))
    .replace(/\.\.\/assets\/elements\/wordmark-bone\.png/g, `${BASE}/carbon-logo-long-white.png`)
    .replace(/\.\.\/assets\/elements\/wordmark-ink\.png/g, `${BASE}/carbon-logo-long-black.png`)
    .replace(/\.\.\/assets\/elements\/([a-z0-9-]+\.png)/g, `${BASE}/pack/$1`);

/** The pack's words, made ready for a text block: headline divs become <h1>, placeholder pictures go. */
const textHtml = (h) =>
  fixCopy(h)
    .replace(/<img[^>]*\.\.\/assets\/placeholders\/[^>]*>/g, "")
    .replace(/<div class="h1" style="([^"]*)">([\s\S]*?)<\/div>/g, (_m, st, inner) => `<h1 style="${st.replace(/font-size:[^;]*;?/g, "").replace(/line-height:[^;]*;?/g, "")}">${inner}</h1>`)
    .replace(/<div([^>]*)>Rows repeat per line item:[\s\S]*?<\/div>/g, "")
    .trim();

/** Top-level <tr> rows of the 600 px table. */
function rows(html) {
  const start = html.indexOf('class="w"');
  const open = html.indexOf(">", start) + 1;
  const out = [];
  let depth = 0;
  let cur = -1;
  const re = /<(\/?)(table|tr)\b[^>]*>/gi;
  re.lastIndex = open;
  let m;
  while ((m = re.exec(html))) {
    const close = m[1] === "/";
    if (m[2].toLowerCase() === "table") {
      if (close) {
        if (depth === 0) break;
        depth--;
      } else depth++;
      continue;
    }
    if (depth !== 0) continue;
    if (!close) cur = m.index;
    else if (cur >= 0) {
      out.push(html.slice(cur, m.index + m[0].length));
      cur = -1;
    }
  }
  return out;
}

const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? null;
function padOf(style) {
  const v = /padding:\s*([^;"]+)/.exec(style ?? "")?.[1];
  if (!v) return [0, 0, 0, 0];
  const n = v.trim().split(/\s+/).map((x) => parseInt(x, 10) || 0);
  const [t, r = t, b = t, l = r] = n;
  return [t, r, b, l];
}
const strip = (h) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/&nbsp;|&rarr;/g, " ").trim();

const emails = [];
for (let n = 11; n <= 70; n++) {
  const name0 = [...prompt.matchAll(new RegExp(`^\\| ${n} \\| ([^|]+)\\| ([^|]+)\\|`, "gm"))][0];
  const fileName = readdirSync(join(dir, "reference-html")).find((f) => f.startsWith(`${n}-`));
  if (!fileName) continue;
  const id = fileName.replace(/\.html$/, "");
  const html = readFileSync(join(dir, "reference-html", fileName), "utf8");
  const pageBg = /<body[^>]*background:(#[0-9A-Fa-f]{6})/.exec(html)?.[1] ?? "#0A0A0A";
  const title = (/<title>([^<]*)/.exec(html)?.[1] ?? id).replace(/^CARBON — /, "");
  const description = name0 ? `${name0[2].trim()}` : "";
  const preheader = strip(/<div style="display:none[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "").replace(/[‌​ ﻿͏]/g, "").trim();
  const plan = [];
  rows(html).forEach((row, i) => {
    const td = /<td\b[^>]*>/.exec(row)?.[0] ?? "";
    const inner = row.replace(/^<tr[^>]*>\s*<td\b[^>]*>/, "").replace(/<\/td>\s*<\/tr>$/, "");
    const bg = attr(td, "bgcolor") ?? /background:(#[0-9A-Fa-f]{6})/.exec(td)?.[1] ?? pageBg;
    const pad = padOf(attr(td, "style"));
    const align = attr(td, "align") ?? (/text-align:center/.test(td) ? "center" : "left");
    if (/assets\/heroes\//.test(row)) {
      const h = /assets\/heroes\/([0-9]+-[a-z0-9-]+)\.jpg/.exec(row)[1];
      plan.push({ t: "hero", layout: h, href: fixCopy(attr(row.match(/<a\b[^>]*>/)?.[0] ?? "", "href") ?? SHOP), alt: attr(row.match(/<img\b[^>]*>/)?.[0] ?? "", "alt") ?? "" });
    } else if (/\{\{unsubscribe_url\}\}/.test(row)) {
      const accent = /border-top:4px solid (#[0-9A-Fa-f]{6})/.exec(td)?.[1] ?? "#F2EFE8";
      const fg = /color:(#[0-9A-Fa-f]{6})/.exec(inner)?.[1] ?? "#F2EFE8";
      plan.push({ t: "footer", bg, fg, accent, dark: /wordmark-ink/.test(row) });
    } else if (i === 0 && /wordmark-/.test(row)) {
      const lab = /<td align="right"[^>]*style="([^"]*)">([\s\S]*?)<\/td>/.exec(inner);
      plan.push({ t: "logo", bg, label: fixCopy(strip(lab?.[2] ?? "")), labelColor: /color:(#[0-9A-Fa-f]{6})/.exec(lab?.[1] ?? "")?.[1] ?? "#F2EFE8", dark: /wordmark-ink/.test(row) });
    } else if (/<!--\[if !mso\]><!--><a /.test(inner) && !strip(inner.replace(/<!--\[if !mso\]><!-->[\s\S]*?<!--<!\[endif\]-->/g, ""))) {
      const a = /<!--\[if !mso\]><!--><a href="([^"]*)" style="([^"]*)">([\s\S]*?)<\/a>/.exec(inner);
      const st = a[2];
      plan.push({
        t: "button",
        bg,
        pad,
        align,
        label: strip(a[3]).replace(/\s+/g, " ") + (/&rarr;/.test(a[3]) ? " →" : ""),
        href: fixCopy(a[1]),
        color: /background:(#[0-9A-Fa-f]{6}|transparent)/.exec(st)?.[1] ?? "#0A0A0A",
        fg: /;color:(#[0-9A-Fa-f]{6})/.exec(st)?.[1] ?? "#F2EFE8",
        outline: /border:3px solid (#[0-9A-Fa-f]{6})/.exec(st)?.[1] ?? null,
      });
    } else if ((row.match(/assets\/placeholders\//g) ?? []).length >= 2 && /\$\d|\{\{cart_total\}\}/.test(row)) {
      const count = (row.match(/assets\/placeholders\//g) ?? []).length;
      // the person's own cart / order — or, for browse-abandon, the pieces they looked at
      const cart = /Qty|cart_total|Order total|TOTAL/i.test(row) || /^4[5]-/.test(fileName);
      const list = cart || /class="h1"|font-size:(?:7|8|9)\dpx/.test(row) || !/class="col"/.test(row);
      plan.push({
        t: "products",
        bg,
        pad,
        n: Math.min(6, count),
        cart,
        list,
        border: /border:3px solid (#[0-9A-Fa-f]{6})/.exec(row)?.[1] ?? null,
        sale: /SALE/.test(row) ? /SALE<\/span>|color:(#[0-9A-Fa-f]{6})[^>]*>SALE/.exec(row)?.[1] ?? null : null,
        fg: /color:(#[0-9A-Fa-f]{6})/.exec(row)?.[1] ?? "#0A0A0A",
      });
    } else if (/^\s*(<a\b[^>]*>)?\s*<img\b[^>]*>\s*(<\/a>)?\s*$/.test(inner)) {
      const img = /<img\b[^>]*>/.exec(inner)[0];
      const src = attr(img, "src");
      plan.push({ t: "image", bg, pad, src: /placeholders/.test(src) ? null : fixCopy(src), alt: attr(img, "alt") ?? "" });
    } else if (/class="col"/.test(inner) && /assets\/placeholders\//.test(inner) && (inner.match(/class="col"/g) ?? []).length === 2) {
      const cells = [...inner.matchAll(/<td class="col"[^>]*>([\s\S]*?)<\/td>(?=\s*(?:<td class="col"|<\/tr>))/g)].map((m) => m[1]);
      const imgFirst = /<img/.test(cells[0] ?? "") && !strip(cells[0] ?? "");
      const textCell = imgFirst ? cells[1] : cells[0];
      const imgCell = imgFirst ? cells[0] : cells[1];
      plan.push({ t: "split", bg, flip: !imgFirst, alt: attr(/<img\b[^>]*>/.exec(imgCell ?? "")?.[0] ?? "", "alt") ?? "", html: textHtml(textCell ?? "") });
    } else if (/>DAYS</.test(inner) && />(?:HRS|HOURS)</.test(inner)) {
      // the countdown cells → CarbonWMS's live countdown picture
      plan.push({ t: "countdown", bg, pad, cell: /background:(#[0-9A-Fa-f]{6})/.exec(inner)?.[1] ?? "#0A0A0A", fg: /font-size:46px;[^"]*color:(#[0-9A-Fa-f]{6})/.exec(inner)?.[1] ?? "#F2EFE8" });
    } else {
      const h = textHtml(inner);
      if (strip(h) || /<img/.test(h)) plan.push({ t: "text", bg, pad, align, html: h });
    }
  });
  emails.push({ id, n, name: title, description, preheader: fixCopy(preheader), pageBg, plan });
}

const banner = `// GENERATED by scripts/gen-email-pack-emails.mjs from the owner's CARBON email pack (2026-11-10). Do not edit by hand.\n`;
const types = `type Pad4 = [number, number, number, number];
export type PackPlanRow =
  | { t: "logo"; bg: string; label: string; labelColor: string; dark: boolean }
  | { t: "hero"; layout: string; href: string; alt: string }
  | { t: "text"; bg: string; pad: Pad4; align: string; html: string }
  | { t: "button"; bg: string; pad: Pad4; align: string; label: string; href: string; color: string; fg: string; outline: string | null }
  | { t: "products"; bg: string; pad: Pad4; n: number; cart: boolean; list: boolean; border: string | null; sale: string | null; fg: string }
  | { t: "image"; bg: string; pad: Pad4; src: string | null; alt: string }
  | { t: "split"; bg: string; flip: boolean; alt: string; html: string }
  | { t: "countdown"; bg: string; pad: Pad4; cell: string; fg: string }
  | { t: "footer"; bg: string; fg: string; accent: string; dark: boolean };
export type PackEmail = { id: string; n: number; name: string; description: string; preheader: string; pageBg: string; plan: PackPlanRow[] };
`;
writeFileSync("lib/email-editor/pack-emails.data.ts", `${banner}${types}export const PACK_EMAILS: PackEmail[] = JSON.parse(${JSON.stringify(JSON.stringify(emails))});\n`);
for (const e of emails) console.log(`${e.id}: ${e.plan.map((p) => p.t).join(" ")}`);
