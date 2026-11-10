/**
 * CarbonWMS Email Editor — the email data → real email HTML (tables + inline styles, one small
 * <style> block for phones). The editor canvas draws every block with the SAME functions
 * (renderBlock), so the canvas, the preview and the sent email match.
 *
 * Phones: the sent email uses @media rules (.ce-col stacks columns, .ce-fw drops side padding,
 * .ce-d / .ce-m hide desktop-only / phone-only parts, .ce-<tag> sets phone text sizes). The canvas
 * cannot use @media (it is not a phone), so renderBlock({ mobile: true }) writes the phone values
 * inline instead.
 *
 * Merge tags ({{first_name}}, {{first_name|friend}}, {{code}} …) are left in place; they are filled
 * per person when the email is sent (rules.ts fillMergeTags).
 */
import { HERO_LAYOUTS, heroAlt, heroPage } from "./heroes";
import {
  fontStack,
  fontsUsed,
  googleFontUrl,
  type Align,
  type Block,
  type Border,
  type EmailDoc,
  type Font,
  type GlobalStyles,
  type HeadingKey,
  type Pad,
  type ProductBlock,
  type ProductItem,
  type Section,
  type TextBlock,
  type SplitCell,
  type Stack,
  type Visibility,
} from "./types";

/** A finished headline picture (made on the server; see PicSource). */
export type Pic = { url: string; w: number; h: number };
/**
 * Ctx.bg: the colour behind the block (null over a section picture → transparent headline picture).
 * Ctx.pics: finished headline pictures by key. Ctx.collect: gathers the headline pictures an email needs.
 */
/** liveHeroes: show hero pictures as their live page (previews before they are drawn). */
export type Ctx = { styles: GlobalStyles; width: number; mobile: boolean; canvas?: boolean; bg?: string | null; pics?: Record<string, Pic>; collect?: PicSource[]; liveHeroes?: boolean };

/* ---------------------------------------------------------------- helpers */

export function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
/** A link for href="…" — merge tags kept, javascript:/data: dropped. */
export function href(u: string): string {
  const s = String(u ?? "").trim();
  if (!s) return "#";
  if (/^\s*(javascript|vbscript|data):/i.test(s)) return "#";
  if (/^(https?:|mailto:|tel:|#|\{\{)/i.test(s)) return esc(s);
  return esc(`https://${s}`);
}
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const padCss = (p: Pad, mobileNoSides = false) => `padding:${px(p.t)} ${px(mobileNoSides ? 0 : p.r)} ${px(p.b)} ${px(mobileNoSides ? 0 : p.l)};`;
const borderCss = (b: Border | null | undefined) => (b && b.width > 0 ? `border:${px(b.width)} ${b.style} ${b.color};` : "");
export function fontCss(f: Font, mobileSize?: number): string {
  return (
    `font-family:${fontStack(f.family)};font-size:${px(mobileSize ?? f.size)};color:${f.color};` +
    (f.ls ? `letter-spacing:${px(f.ls)};` : "") +
    `font-weight:${f.bold ? 700 : 400};` +
    (f.italic ? "font-style:italic;" : "") +
    (f.underline || f.strike ? `text-decoration:${[f.underline ? "underline" : "", f.strike ? "line-through" : ""].join(" ").trim()};` : "")
  );
}
const visAttrs = (v: Visibility, mobile: boolean, canvas: boolean): { cls: string; style: string; hidden: boolean } => {
  if (canvas) return { cls: "", style: "", hidden: (v === "desktop" && mobile) || (v === "mobile" && !mobile) };
  if (v === "desktop") return { cls: " ce-d", style: "", hidden: false };
  if (v === "mobile") return { cls: " ce-m", style: "display:none;max-height:0;overflow:hidden;mso-hide:all;", hidden: false };
  return { cls: "", style: "", hidden: false };
};
const T = (inner: string, attrs = "", style = "") =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${attrs} style="border-collapse:collapse;${style}"><tr>${inner}</tr></table>`;

/** A merge tag as a grey chip on the canvas ({{first_name|friend}} → [First name]). */
const TAG_NAMES: Record<string, string> = {
  first_name: "First name",
  greeting_name: "First name",
  code: "Code",
  code_url: "Code link",
  offer_amount: "Offer",
  offer_ends: "Offer end date",
  shop_url: "Shop link",
  instagram_url: "Instagram link",
  unsubscribe_url: "Unsubscribe link",
  checkout_url: "Checkout link",
  order_name: "Order number",
};
export function chipTags(html: string): string {
  return html.replace(/\{\{\s*([a-z_]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_m, tag: string) => {
    if (tag === "code") return `<span style="font-family:'Courier New',monospace;background:rgba(127,127,127,.15);padding:0 4px;border-radius:3px">CB20-AB12CD</span>`;
    if (tag === "offer_amount") return "$20";
    if (tag === "offer_ends") return "Sunday, Nov 30";
    if (tag === "order_name") return "#1084";
    return `<span style="background:#E8E8E8;color:#444;border-radius:3px;padding:0 4px;font-size:.85em">${esc(TAG_NAMES[tag] ?? tag)}</span>`;
  });
}

/* ------------------------------------------------------------------ text */

const TEXT_TAGS: Record<string, HeadingKey> = { p: "body", li: "body", div: "body", h1: "h1", h2: "h2", h3: "h3", h4: "h4" };

/**
 * Inline the email's text styles into the tags of a text block (<p>, <h1>–<h4>, <a>, lists). The
 * block's own inline styles (alignment, colour set in the toolbar) win: they are written after.
 */
export function styleText(html: string, s: GlobalStyles, mobile: boolean): string {
  return html.replace(/<(p|h1|h2|h3|h4|a|ul|ol|li|div)(\s[^>]*)?>/gi, (_m, tag0: string, attrs0: string | undefined) => {
    const tag = tag0.toLowerCase();
    let attrs = attrs0 ?? "";
    const own = /\sstyle\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? "";
    attrs = attrs.replace(/\sstyle\s*=\s*"[^"]*"/i, "").replace(/\sclass\s*=\s*"[^"]*"/i, "");
    let base = "";
    if (tag === "a") {
      const l = s.link;
      base = `color:${l.color};font-weight:${l.bold ? 700 : "inherit"};font-style:${l.italic ? "italic" : "inherit"};text-decoration:${l.underline ? "underline" : "none"};`;
    } else if (tag === "ul" || tag === "ol") {
      base = "margin:0 0 0 0;padding:0 0 0 24px;";
    } else {
      const k = TEXT_TAGS[tag] ?? "body";
      const t = s.text[k];
      base =
        `margin:0;font-family:${fontStack(t.family)};font-size:${px(mobile ? s.mobile.sizes[k] : t.size)};line-height:${t.lh};color:${t.color};` +
        `font-weight:${t.bold ? 700 : 400};${t.italic ? "font-style:italic;" : ""}${t.ls ? `letter-spacing:${px(t.ls)};` : ""}text-align:${t.align};` +
        (tag === "li" ? "margin:0 0 4px;" : "");
    }
    const cls = tag === "a" || tag === "ul" || tag === "ol" ? "" : ` class="ce-${TEXT_TAGS[tag] ?? "body"}"`;
    return `<${tag}${attrs}${cls} style="${base}${own}">`;
  });
}

/**
 * A font picked in the text toolbar ("font-family: &quot;Playfair Display&quot;") becomes the
 * font with its fallback, so Gmail shows a close match.
 */
export function fixFamilies(html: string): string {
  return html.replace(/font-family:\s*(?:&quot;|"|')?([A-Za-z0-9 ]+?)(?:&quot;|"|')?\s*(;|(?="))/g, (_m, name: string, end: string) => `font-family:${fontStack(name.trim()).replace(/"/g, "'")}${end}`);
}

/** Empty paragraphs keep their height (an editor <p><br></p> is a blank line). */
const fixEmpty = (html: string) => html.replace(/<p([^>]*)>\s*(<br\s*\/?>)?\s*<\/p>/gi, "<p$1>&nbsp;</p>");

function textHtml(html: string, ctx: Ctx): string {
  const h = styleText(fixFamilies(fixEmpty(html || "")), ctx.styles, ctx.mobile);
  return ctx.canvas ? chipTags(h) : h;
}

/* ------------------------------------------------------------------ blocks */

function wrapBlock(b: Block, ctx: Ctx, inner: string, extraTd = ""): string {
  const v = visAttrs(b.visibility, ctx.mobile, !!ctx.canvas);
  if (v.hidden) return "";
  const noSides = ctx.mobile && b.fullMobile;
  return T(
    `<td class="ce-blk${b.fullMobile ? " ce-fw" : ""}" style="${padCss(b.pad, noSides)}${b.bg ? `background-color:${b.bg};` : ""}${extraTd}">${inner}</td>`,
    v.cls ? ` class="${v.cls.trim()}"` : "",
    v.style,
  );
}

/** Inner width of a block (column width minus the block's side padding). */
export const innerWidth = (b: Block, ctx: Ctx) => Math.max(40, ctx.width - (ctx.mobile && b.fullMobile ? 0 : b.pad.l + b.pad.r));

function img(src: string, alt: string, w: number, opts: { link?: string; radius?: number; fillMobile?: boolean; style?: string } = {}): string {
  const i = `<img src="${esc(src)}" alt="${esc(alt)}" width="${Math.round(w)}" class="${opts.fillMobile ? "ce-imgm" : ""}" style="display:block;width:100%;max-width:${Math.round(w)}px;height:auto;border:0;outline:none;text-decoration:none;${opts.radius ? `border-radius:${px(opts.radius)};` : ""}${opts.style ?? ""}">`;
  return opts.link ? `<a href="${href(opts.link)}" target="_blank" style="text-decoration:none;">${i}</a>` : i;
}

function placeholder(h: number, label: string): string {
  return `<div style="height:${h}px;background:#E9E9EB;color:#8a8a90;font:13px/1.3 Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center;">${esc(label)}</div>`;
}

function button(text: string, link: string, f: Font, color: string, radius: number, p: { v: number; h: number }, opts: { full?: boolean; align?: Align; border?: Border | null; shadow?: string | null } = {}): string {
  const a = `<a href="${href(link)}" target="_blank" style="display:${opts.full ? "block" : "inline-block"};${fontCss(f)}text-decoration:${f.underline ? "underline" : "none"};padding:${px(p.v)} ${px(p.h)};border-radius:${px(radius)};line-height:1.2;text-align:center;mso-padding-alt:0;">${esc(text)}</a>`;
  const td = `<td align="center" bgcolor="${color}" style="background-color:${color};border-radius:${px(radius)};${borderCss(opts.border)}${opts.shadow ? `box-shadow:0 4px 10px ${opts.shadow};` : ""}">${a}</td>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${opts.full ? "center" : (opts.align ?? "center")}" ${opts.full ? 'width="100%"' : ""} style="border-collapse:separate;${opts.full ? "width:100%;" : ""}margin:${opts.align === "left" ? "0 auto 0 0" : opts.align === "right" ? "0 0 0 auto" : "0 auto"};"><tr>${td}</tr></table>`;
}

const money = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

function productCell(p: ProductItem | null, b: ProductBlock, w: number, ctx: Ctx): string {
  if (!p) {
    if (!ctx.canvas) return "";
    const ph = Math.round(b.imgRatio === "1:1" ? w : w * 1.25);
    return `${placeholder(ph, "Product")}<div style="${fontCss(b.nameFont)}padding-top:8px;text-align:${b.align}">Product name</div><div style="${fontCss(b.priceFont)}text-align:${b.align}">$X.XX</div>`;
  }
  const al = `text-align:${b.align};`;
  const ratioCss = b.imgRatio === "auto" ? "" : `height:${Math.round(b.imgRatio === "1:1" ? w : w * 1.25)}px;object-fit:cover;`;
  const pic = p.image ? img(p.image, p.title, w, { link: p.url, style: ratioCss }) : placeholder(Math.round(w * 1.25), p.title);
  const parts: string[] = [];
  if (p.set) parts.push(`<div style="${fontCss({ ...b.nameFont, size: Math.max(9, b.nameFont.size - 4), bold: true, ls: 1.5, color: "#666666" })}${al}padding-top:10px;">${p.set.pieces}-PIECE SET</div>`);
  if (b.showName) parts.push(`<div style="${fontCss(b.nameFont)}${al}padding-top:${p.set ? 2 : 10}px;line-height:1.3;"><a href="${href(p.url)}" target="_blank" style="color:${b.nameFont.color};text-decoration:none;">${esc(p.title)}</a></div>`);
  if (p.set) parts.push(`<div style="${fontCss({ ...b.nameFont, size: Math.max(10, b.nameFont.size - 2), color: "#666666" })}${al}padding-top:2px;">${esc(p.set.line)}</div>`);
  if (b.showPrice) {
    const cmp = b.showCompare && !p.set && p.compareAt && p.compareAt > p.price ? ` <span style="text-decoration:line-through;color:#8a8a8a;font-weight:400;">${money(p.compareAt)}</span>` : "";
    parts.push(`<div style="${fontCss(b.priceFont)}${al}padding-top:4px;">${p.set ? `Set ${money(p.set.total)}` : money(p.price)}${cmp}</div>`);
  }
  if (b.showButton) parts.push(`<div style="padding-top:10px;">${button(b.buttonText, p.url, b.btnFont, b.btnColor, b.btnRadius, b.btnPad, { align: b.align })}</div>`);
  const text = parts.join("");
  if (b.orientation === "vertical" || (ctx.mobile && b.perRow > 1)) return `${pic}${text}`;
  const half = Math.round(w / 2 - 8);
  const picHalf = p.image ? img(p.image, p.title, half, { link: p.url }) : placeholder(Math.round(half * 1.25), p.title);
  const l = `<td width="50%" valign="middle" style="padding-right:8px;">${b.orientation === "image-left" ? picHalf : text}</td>`;
  const r = `<td width="50%" valign="middle" style="padding-left:8px;">${b.orientation === "image-left" ? text : picHalf}</td>`;
  return T(l + r);
}

/** The products a product block shows (static: its picks; dynamic: its feed from start item, rows × per row). */
export function productList(b: ProductBlock): (ProductItem | null)[] {
  const n = b.source === "dynamic" ? b.perRow * b.rows : Math.max(1, b.items.length);
  const src = b.source === "dynamic" ? b.items.slice(Math.max(0, b.startAt - 1)) : b.items;
  return Array.from({ length: n }, (_, i) => src[i] ?? null).slice(0, b.source === "static" && b.items.length ? b.items.length : n);
}

function productBlock(b: ProductBlock, ctx: Ctx): string {
  const items = productList(b);
  if (!ctx.canvas && !items.some(Boolean)) return "";
  const W = innerWidth(b, ctx);
  const perRow = ctx.mobile ? (b.perRow >= 3 ? 2 : b.perRow) : b.perRow;
  const g = b.gap;
  const cellW = (W - g * (perRow - 1)) / perRow;
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += perRow) {
    const row = items.slice(i, i + perRow);
    const cells = row
      .map((p, j) => {
        const cls = !ctx.canvas && b.perRow >= 3 ? ' class="ce-p2"' : !ctx.canvas && b.perRow > 1 ? ' class="ce-pc"' : "";
        return `<td${cls} width="${Math.round(100 / perRow)}%" valign="top" style="width:${Math.round(100 / perRow)}%;padding:0 ${px(j < perRow - 1 ? g / 2 : 0)} ${px(g)} ${px(j > 0 ? g / 2 : 0)};${borderCss(b.border)}">${productCell(p, b, cellW, ctx)}</td>`;
      })
      .join("");
    const fill = Array.from({ length: perRow - row.length }, () => `<td width="${Math.round(100 / perRow)}%" style="width:${Math.round(100 / perRow)}%"></td>`).join("");
    rows.push(`<tr>${cells}${fill}</tr>`);
  }
  return wrapBlock(b, ctx, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;table-layout:fixed;">${rows.join("")}</table>`);
}

function splitCell(c: SplitCell, w: number, ctx: Ctx): string {
  if (c.kind === "text") return `<div style="font-family:${fontStack(ctx.styles.text.body.family)}">${textHtml(c.html, ctx)}</div>`;
  if (c.kind === "html") return c.code;
  return c.src ? img(c.src, c.alt, w, { link: c.href, fillMobile: true }) : ctx.canvas ? placeholder(Math.round(w * 0.9), "Image") : "";
}

/** Two or more cells side by side, stacking on phones in the chosen order. */
function cols(cells: { html: string; w: number }[], stack: Stack, valign: string, gap: number, ctx: Ctx): string {
  const stacking = ctx.mobile && stack !== "none";
  if (stacking) {
    const order = stack === "right-first" ? [...cells].reverse() : cells;
    return order.map((c, i) => T(`<td style="padding:${i ? px(gap) : 0} 0 0 0;">${c.html}</td>`)).join("");
  }
  const rtl = stack === "right-first";
  const list = rtl ? [...cells].reverse() : cells;
  const n = list.length;
  const tds = list
    .map((c, i) => {
      const pl = i > 0 ? gap / 2 : 0;
      const pr = i < n - 1 ? gap / 2 : 0;
      const cls = !ctx.canvas && stack !== "none" ? ' class="ce-col"' : "";
      return `<td${cls} dir="ltr" width="${c.w}%" valign="${valign}" style="width:${c.w}%;padding:0 ${px(pr)} 0 ${px(pl)};vertical-align:${valign};">${c.html}</td>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"${rtl ? ' dir="rtl"' : ""} style="border-collapse:collapse;table-layout:fixed;"><tr>${tds}</tr></table>`;
}

const SOCIAL_PX = { s: 24, m: 32, l: 40 } as const;

export function renderBlock(b: Block, ctx: Ctx): string {
  const W = innerWidth(b, ctx);
  switch (b.type) {
    case "text": {
      const inner = `<div style="${padCss(b.areaPad)}${b.areaBg ? `background-color:${b.areaBg};` : ""}${borderCss(b.border)}font-family:${fontStack(ctx.styles.text.body.family)};">${textHtml(b.html, ctx)}</div>`;
      const src = b.asPic && !ctx.canvas ? picSource(b, inner, ctx) : null;
      if (src) {
        ctx.collect?.push(src);
        const pic = ctx.pics?.[src.key];
        if (pic) return wrapBlock(b, ctx, picImg(pic, src));
      }
      return wrapBlock(b, ctx, inner);
    }
    case "image": {
      if (!b.src) return ctx.canvas ? wrapBlock(b, ctx, placeholder(180, "Drop an image here")) : "";
      const natural = b.natW ?? W;
      const w = b.fill || (ctx.mobile && b.fillMobile) ? W : Math.min(W, b.width ?? natural);
      const al = b.align;
      return wrapBlock(
        b,
        ctx,
        `<div style="${b.areaBg ? `background-color:${b.areaBg};` : ""}${borderCss(b.border)}"><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${al}" style="margin:${al === "left" ? "0 auto 0 0" : al === "right" ? "0 0 0 auto" : "0 auto"};"><tr><td>${img(b.src, b.alt, w, { link: b.href, radius: b.radius, fillMobile: b.fillMobile })}</td></tr></table></div>`,
      );
    }
    case "split": {
      const gap = b.spacing;
      const avail = W - gap;
      const cells = b.cells.map((c, i) => ({ html: splitCell(c, ctx.mobile && b.stack !== "none" ? W : (avail * b.widths[i]) / 100, ctx), w: b.widths[i] }));
      return wrapBlock(b, ctx, cols(cells, b.stack, b.valign, gap, ctx));
    }
    case "button":
      return wrapBlock(b, ctx, button(b.text, b.href, b.font, b.color, b.radius, b.btnPad, { full: b.full, align: b.align, border: b.border, shadow: b.shadow }));
    case "header": {
      const logo = b.logo ? img(b.logo, "CARBON", Math.min(b.logoWidth, W), { link: b.logoHref }) : "";
      const link = (l: { text: string; href: string }) =>
        `<a href="${href(l.href)}" target="_blank" style="${fontCss(b.linkFont)}text-decoration:${b.linkFont.underline ? "underline" : "none"};display:inline-block;padding:${px(b.linkPad.v)} ${px(b.linkPad.h)};">${esc(l.text)}</a>`;
      const links = b.links.map(link).join("");
      const logoT = (al: Align) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${al}" style="margin:${al === "center" ? "0 auto" : al === "left" ? "0 auto 0 0" : "0 0 0 auto"};"><tr><td>${logo}</td></tr></table>`;
      const layout = ctx.mobile ? (b.mobileLayout === "stack" ? "stacked" : b.mobileLayout === "links" ? "links" : "inline") : b.layout;
      let inner: string;
      if (layout === "links") inner = `<div style="text-align:${b.align};">${links}</div>`;
      else if (layout === "inline" && b.links.length)
        inner = T(`<td valign="middle" style="width:45%;">${logoT("left")}</td><td valign="middle" align="right" style="text-align:right;">${links}</td>`);
      else if (layout === "centered" && b.links.length) {
        const half = Math.ceil(b.links.length / 2);
        inner = T(
          `<td valign="middle" align="left" style="width:35%;text-align:left;">${b.links.slice(0, half).map(link).join("")}</td><td valign="middle" style="width:30%;">${logoT("center")}</td><td valign="middle" align="right" style="width:35%;text-align:right;">${b.links.slice(half).map(link).join("")}</td>`,
        );
      } else inner = `${logo ? logoT(b.align) : ""}${b.links.length ? `<div style="text-align:${b.align};padding-top:${logo ? 10 : 0}px;">${links}</div>` : ""}`;
      return wrapBlock(b, ctx, inner);
    }
    case "divider":
      return wrapBlock(b, ctx, `<div style="width:${b.lineWidth}%;margin:0 auto;border-top:${px(b.width)} ${b.style} ${b.color};font-size:0;line-height:0;height:0;">&nbsp;</div>`);
    case "spacer":
      return wrapBlock(b, ctx, `<div style="height:${px(b.height)};font-size:0;line-height:0;">&nbsp;</div>`);
    case "social": {
      const size = SOCIAL_PX[b.size];
      const base = ctx.canvas ? "/email/social" : "https://wms.shopcarbon.com/email/social";
      const items = b.items
        .map(
          (it, i) =>
            `<td style="padding:0 ${px(i < b.items.length - 1 ? b.spacing / 2 : 0)} 0 ${px(i > 0 ? b.spacing / 2 : 0)};text-align:center;" valign="top"><a href="${href(it.href)}" target="_blank" style="text-decoration:none;"><img src="${base}/${it.net}-${b.color}.png" width="${size}" height="${size}" alt="${esc(it.label || it.net)}" style="display:block;width:${size}px;height:${size}px;border:0;margin:0 auto;"></a>${b.showLabels ? `<div style="${fontCss(b.labelFont)}padding-top:4px;">${esc(it.label)}</div>` : ""}</td>`,
        )
        .join("");
      return wrapBlock(
        b,
        ctx,
        `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${b.align}" style="margin:${b.align === "center" ? "0 auto" : b.align === "left" ? "0 auto 0 0" : "0 0 0 auto"};border-collapse:collapse;"><tr>${items}</tr></table>`,
      );
    }
    case "product":
      return productBlock(b, ctx);
    case "code": {
      const al = `text-align:${b.align};`;
      const code = ctx.canvas ? "CB20-AB12CD" : "{{code}}";
      const note = ctx.canvas ? chipTags(esc(b.note)) : esc(b.note);
      const btn = b.button ? `<div style="padding-top:16px;">${button(b.buttonText, "{{code_url}}", b.btnFont, b.btnColor, 0, { v: 14, h: 32 }, { align: b.align })}</div>` : "";
      return wrapBlock(
        b,
        ctx,
        `<div style="${al}">${b.title ? `<div style="${fontCss(b.titleFont)}${al}padding-bottom:10px;">${esc(b.title)}</div>` : ""}<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${b.align}" style="margin:${b.align === "center" ? "0 auto" : b.align === "left" ? "0 auto 0 0" : "0 0 0 auto"};border-collapse:separate;"><tr><td style="background-color:${b.boxBg};${borderCss(b.boxBorder)}padding:14px 28px;${fontCss(b.codeFont)}">${code}</td></tr></table>${b.note ? `<div style="${fontCss(b.noteFont)}${al}padding-top:12px;line-height:1.5;">${note}</div>` : ""}${btn}</div>`,
      );
    }
    case "video": {
      if (!b.thumb) return ctx.canvas ? wrapBlock(b, ctx, placeholder(200, "Video: add a thumbnail picture and the video link")) : "";
      const pic = img(b.thumb, b.alt, W, { link: b.href, radius: b.radius, fillMobile: true });
      return wrapBlock(
        b,
        ctx,
        `${pic}<div style="text-align:${b.align};padding-top:10px;"><a href="${href(b.href)}" target="_blank" style="font:700 13px/1.2 Helvetica,Arial,sans-serif;letter-spacing:1px;color:#111111;text-decoration:none;">&#9654;&nbsp; ${esc(b.alt || "Watch the video").toUpperCase()}</a></div>`,
      );
    }
    case "html":
      return wrapBlock(b, ctx, b.code || "");
    case "hero": {
      const page = heroPage(b);
      const H = HERO_LAYOUTS[b.layout]?.height ?? 700;
      if (ctx.canvas || ctx.liveHeroes) {
        // The editor shows the drawing page itself (scaled to the column), so what you see is the picture.
        const k = W / 600;
        return wrapBlock(
          b,
          ctx,
          `<div style="width:${Math.round(W)}px;height:${Math.round(H * k)}px;overflow:hidden;"><iframe title="Hero" sandbox="allow-scripts" scrolling="no" srcdoc="${esc(page)}" style="border:0;width:600px;height:${H}px;transform:scale(${k});transform-origin:0 0;pointer-events:none;display:block;"></iframe></div>`,
        );
      }
      const src: PicSource = { key: picKey(page), page, width: 600, bg: HERO_LAYOUTS[b.layout]?.bg ?? null, alt: b.alt || heroAlt(b), link: b.href || null, fragment: "", jpg: true };
      ctx.collect?.push(src);
      const pic = ctx.pics?.[src.key];
      // Not drawn yet (it is drawn before any preview, test or send): the first photo stands in.
      if (!pic) return b.photos.find(Boolean) ? wrapBlock(b, ctx, img(b.photos.find(Boolean)!, src.alt, W, { link: b.href, fillMobile: true })) : "";
      return wrapBlock(b, ctx, picImg(pic, { ...src, width: Math.round(W) }));
    }
  }
}

/* ---------------------------------------------------------------- sections */

/** Width of each column's content in a section (px), desktop or phone. */
export function columnWidths(s: Section, styles: GlobalStyles, mobile: boolean): number[] {
  const content = (mobile ? 375 - styles.mobile.margin * 2 : styles.width) - styles.pad.l - styles.pad.r - s.pad.l - s.pad.r;
  if (mobile && s.stack !== "none") return s.cols.map(() => content);
  const avail = content - s.gap * (s.cols.length - 1);
  return s.cols.map((c) => (avail * c.w) / 100);
}

export function renderSection(s: Section, styles: GlobalStyles, mobile: boolean, canvas = false, extra: Pick<Ctx, "pics" | "collect" | "liveHeroes"> = {}): string {
  const v = visAttrs(s.visibility, mobile, canvas);
  if (v.hidden) return "";
  const widths = columnWidths(s, styles, mobile);
  const behind = s.contentBg || (s.bgImage ? null : s.bg || styles.contentBg || styles.pageBg);
  const colHtml = s.cols.map((c, i) => ({ html: c.blocks.map((b) => renderBlock(b, { styles, width: widths[i], mobile, canvas, bg: b.bg || behind, ...extra })).join(""), w: c.w }));
  const inner = s.cols.length === 1 ? colHtml[0].html : cols(colHtml, s.stack, s.valign, s.gap, { styles, width: 0, mobile, canvas });
  const bgImg = s.bgImage ? `background-image:url('${esc(s.bgImage)}');background-size:cover;background-position:center;` : "";
  return T(
    `<td${s.bgImage ? ` background="${esc(s.bgImage)}"` : ""} style="${padCss(s.pad)}${s.bg ? `background-color:${s.bg};` : ""}${bgImg}"><div style="${s.contentBg ? `background-color:${s.contentBg};` : ""}">${inner}</div></td>`,
    v.cls ? ` class="${v.cls.trim()}"` : "",
    v.style,
  );
}

/* ------------------------------------------------------- headline pictures */

/**
 * "Send as a picture": everything the server needs to draw a text block in its exact font — a
 * small standalone page (the block at its real width, its fonts, the colour behind it) — and a key
 * that changes whenever any of that changes. The same words in the same style anywhere share one
 * picture. Not for blocks with personal tags (a picture cannot say each person's name) or long
 * body copy (pictures of paragraphs read badly and look like spam).
 */
/** jpg: a hero picture (photos), drawn as JPG; otherwise a headline, drawn as PNG. */
export type PicSource = { key: string; page: string; width: number; bg: string | null; alt: string; link: string | null; fragment: string; jpg?: boolean };

export const PIC_MAX_CHARS = 320;
const PIC_VERSION = "p1";

/** The words of a text block (for the picture's alt text and the length limit). */
export function plainText(html: string): string {
  return String(html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|h[1-6]|li|div)>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Why a text block cannot be sent as a picture (null = it can). */
export function picBlocked(html: string): string | null {
  if (/\{\{/.test(html)) return "It has a personal tag (like the first name); a picture would say the same thing to everyone, so it is sent as text.";
  const t = plainText(html);
  if (!t) return "It has no words yet.";
  if (t.length > PIC_MAX_CHARS) return `It is too long for a picture (${t.length} letters; up to ${PIC_MAX_CHARS}). Use it for headlines and short lines.`;
  return null;
}

/** 64-bit FNV-1a as 16 hex characters (the same in the browser and on the server). */
export function hashKey(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** The fonts a piece of HTML names (Google fonts, so the drawing page can load them). */
function fontsIn(html: string, styles: GlobalStyles) {
  return fontsUsed({ html, styles });
}

/** The page the server draws, for one block's inner HTML (also used for translated words). */
export function picPage(fragment: string, width: number, bg: string | null, styles: GlobalStyles): string {
  const fonts = fontsIn(fragment, styles)
    .map((f) => `<link rel="stylesheet" href="${googleFontUrl(f)}">`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8">${fonts}<style>html,body{margin:0;padding:0;background:${bg ?? "transparent"};}#pic{width:${width}px;}</style></head><body><div id="pic">${fragment}</div></body></html>`;
}

/** The key of a drawing page. */
export const picKey = (page: string) => hashKey(`${PIC_VERSION}|${page}`);

function picSource(b: TextBlock, inner: string, ctx: Ctx): PicSource | null {
  if (picBlocked(b.html)) return null;
  const width = Math.round(innerWidth(b, ctx));
  const bg = ctx.bg ?? null;
  const page = picPage(inner, width, bg, ctx.styles);
  const link = /<a\b[^>]*href="([^"]*)"/i.exec(b.html)?.[1]?.replace(/&amp;/g, "&") ?? null;
  return { key: picKey(page), page, width, bg, alt: plainText(b.html), link, fragment: inner };
}

/** The headline picture in the email: full block width, shrinks on phones; styled alt text when pictures are off. */
function picImg(p: Pic, src: PicSource): string {
  const t = ` style="display:block;width:100%;max-width:${src.width}px;height:auto;border:0;outline:none;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-size:22px;line-height:1.25;color:${isDark(src.bg) ? "#FFFFFF" : "#111111"};"`;
  const i = `<img src="${esc(p.url)}" alt="${esc(src.alt)}" width="${src.width}" class="ce-imgm"${t}>`;
  return src.link ? `<a href="${href(src.link)}" target="_blank" style="text-decoration:none;">${i}</a>` : i;
}

/** A dark colour (so the words shown while pictures are off are light on it). */
function isDark(c: string | null): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(c ?? "");
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 128;
}

/** The headline pictures an email needs (each with its drawing page and key). */
export function picSources(doc: EmailDoc): PicSource[] {
  const out: PicSource[] = [];
  renderEmail(doc, {}, out);
  const seen = new Set<string>();
  return out.filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
}

/* ------------------------------------------------------------------ email */

export const BG_MARK = (c: string) => `<!--carbon-bg:${c}-->`;

/** The phone rules of the sent email. */
function phoneCss(s: GlobalStyles): string {
  const sizes = (["body", "h1", "h2", "h3", "h4"] as HeadingKey[]).map((k) => `.ce-${k}{font-size:${s.mobile.sizes[k]}px!important}`).join("");
  return `<style>
@media only screen and (max-width:620px){
.ce-wrap{width:100%!important;max-width:100%!important}
.ce-outer{padding-left:${s.mobile.margin}px!important;padding-right:${s.mobile.margin}px!important}
.ce-col{display:block!important;width:100%!important;max-width:100%!important;padding-left:0!important;padding-right:0!important;padding-top:12px!important}
.ce-col:first-child{padding-top:0!important}
.ce-fw{padding-left:0!important;padding-right:0!important}
.ce-d{display:none!important;max-height:0!important;overflow:hidden!important}
.ce-m{display:table!important;width:100%!important;max-height:none!important;overflow:visible!important}
.ce-imgm{width:100%!important;max-width:100%!important;height:auto!important}
.ce-p2{display:inline-block!important;width:50%!important;box-sizing:border-box}
${sizes}
}
</style>`;
}

/** The whole email (a full HTML document; wrapEmail adds the preheader, language bar and footer). */
export function renderEmail(doc: EmailDoc, pics: Record<string, Pic> = {}, collect?: PicSource[], opts: { liveHeroes?: boolean } = {}): string {
  const s = doc.styles;
  const sections = doc.sections.map((sec) => renderSection(sec, s, false, false, { pics, collect, liveHeroes: opts.liveHeroes })).join("\n");
  // Web fonts (Apple Mail, iPhone, Samsung, Outlook for Mac load them; Gmail shows the fallback).
  const fonts = fontsUsed(doc)
    .map((f) => `<style>@import url('${googleFontUrl(f)}');</style>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${fonts}${phoneCss(s)}</head>
<body style="margin:0;padding:0;background-color:${s.pageBg};">${BG_MARK(s.pageBg)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${s.pageBg}" style="background-color:${s.pageBg};border-collapse:collapse;"><tr><td class="ce-outer" align="center" style="padding:${px(s.marginTop)} 0 0 0;">
<!--[if mso]><table role="presentation" width="${s.width}" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table class="ce-wrap" role="presentation" width="${s.width}" cellpadding="0" cellspacing="0" border="0" style="width:${s.width}px;max-width:${s.width}px;background-color:${s.contentBg};border-collapse:separate;${s.radius ? `border-radius:${px(s.radius)};overflow:hidden;` : ""}${borderCss(s.border)}"><tr><td style="${padCss(s.pad)}">
${sections}
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table>
</body></html>`;
}
