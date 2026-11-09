/**
 * CarbonWMS Email Editor — the email as data (owner, 2026-11-09: "copy the layout and the email
 * module of Klaviyo, and how it works"). Built like Klaviyo's drag-and-drop editor:
 *
 *   Email (global styles) → Section (1–4 columns, background, padding, stacking) → Column → Blocks
 *
 * Every block has the same "Styles" basics (block background, block padding, full width on phone)
 * and the same "Display" tab (all devices / desktop only / phone only). The data is rendered to real
 * email HTML by render.ts — the same code draws the editor canvas, so what you see is what is sent.
 *
 * Pure (no server or browser APIs): used by the editor in the browser and by the server on save.
 */

export type Pad = { t: number; r: number; b: number; l: number };
export type Border = { style: "solid" | "dashed" | "dotted"; width: number; color: string };
export type Align = "left" | "center" | "right";
export type Visibility = "all" | "desktop" | "mobile";

export type Font = {
  family: string;
  size: number;
  color: string;
  ls: number; // letter spacing, px
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
};

export type TextStyle = Font & { lh: number; align: Align };

type Base = {
  id: string;
  bg: string | null; // block background (optional group)
  pad: Pad; // block padding
  fullMobile: boolean; // full width on mobile (drops side padding on phones)
  visibility: Visibility;
};

/**
 * asPic: "Send as a picture" (owner, 2026-11-09) — the block is drawn once on the server in the
 * exact font and sent as an <img> (the words in its alt text), so Gmail and Outlook show the real
 * typeface. The editor canvas keeps showing live, editable text.
 */
export type TextBlock = Base & { type: "text"; html: string; areaPad: Pad; areaBg: string | null; border: Border | null; asPic?: boolean };

export type ImageBlock = Base & {
  type: "image";
  src: string | null;
  alt: string;
  href: string;
  /** null = auto (the picture's own width, never wider than the column) */
  width: number | null;
  natW: number | null;
  natH: number | null;
  align: Align;
  fill: boolean; // fill column (desktop)
  fillMobile: boolean;
  radius: number;
  areaBg: string | null;
  border: Border | null;
};

export type SplitCell = { kind: "text"; html: string } | { kind: "image"; src: string | null; alt: string; href: string } | { kind: "html"; code: string };
export type Stack = "left-first" | "right-first" | "none";

export type SplitBlock = Base & { type: "split"; cells: [SplitCell, SplitCell]; widths: [number, number]; spacing: number; stack: Stack; valign: "top" | "middle" | "bottom" };

export type ButtonBlock = Base & {
  type: "button";
  text: string;
  href: string;
  font: Font;
  color: string; // button colour
  radius: number;
  full: boolean; // full width (otherwise fit to text)
  align: Align;
  btnPad: { v: number; h: number };
  border: Border | null;
  shadow: string | null;
};

export type HeaderLink = { id: string; text: string; href: string };
export type HeaderBlock = Base & {
  type: "header";
  logo: string | null; // logo picture URL (null = no logo)
  logoWidth: number;
  logoHref: string;
  layout: "stacked" | "inline" | "centered" | "links";
  mobileLayout: "stack" | "inline" | "links";
  links: HeaderLink[];
  linkFont: Font;
  linkPad: { v: number; h: number };
  align: Align;
};

export type DividerBlock = Base & { type: "divider"; style: Border["style"]; width: number; color: string; lineWidth: number /* % of the column */ };
export type SpacerBlock = Base & { type: "spacer"; height: number };

export type SocialNet = "instagram" | "facebook" | "tiktok" | "youtube" | "website";
export type SocialItem = { id: string; net: SocialNet; href: string; label: string };
export type SocialBlock = Base & {
  type: "social";
  items: SocialItem[];
  size: "s" | "m" | "l";
  color: "black" | "grey" | "white" | "brand";
  align: Align;
  spacing: number;
  showLabels: boolean;
  labelFont: Font;
};

export type ProductItem = {
  id: string;
  title: string;
  price: number;
  compareAt: number | null;
  image: string | null;
  url: string;
  /** A matching set shown as one card (like the homepage): "Hoodie $71.00 + Pants $69.00", "Set $140.00". */
  set?: { line: string; total: number; pieces: number } | null;
};
export type ProductFeed = "newest" | "women" | "men" | "most-stock";
export type ProductBlock = Base & {
  type: "product";
  source: "static" | "dynamic";
  feed: ProductFeed;
  startAt: number; // dynamic: start with item n (1-based)
  items: ProductItem[];
  perRow: number; // 1–6
  rows: number; // 1–6 (dynamic)
  orientation: "vertical" | "image-left" | "image-right";
  align: Align;
  gap: number;
  imgRatio: "4:5" | "1:1" | "auto";
  showName: boolean;
  showPrice: boolean;
  showCompare: boolean;
  showButton: boolean;
  buttonText: string;
  nameFont: Font;
  priceFont: Font;
  btnFont: Font;
  btnColor: string;
  btnRadius: number;
  btnPad: { v: number; h: number };
  border: Border | null;
};

/** The person's own discount code ({{code}}), with the offer text around it. */
export type CodeBlock = Base & {
  type: "code";
  title: string;
  note: string; // may use {{offer_amount}} / {{offer_ends}}
  codeFont: Font;
  boxBg: string;
  boxBorder: Border | null;
  titleFont: Font;
  noteFont: Font;
  align: Align;
  button: boolean;
  buttonText: string;
  btnColor: string;
  btnFont: Font;
};

export type VideoBlock = Base & { type: "video"; thumb: string | null; href: string; alt: string; align: Align; radius: number };
export type HtmlBlock = Base & { type: "html"; code: string };

export type Block = TextBlock | ImageBlock | SplitBlock | ButtonBlock | HeaderBlock | DividerBlock | SpacerBlock | SocialBlock | ProductBlock | CodeBlock | VideoBlock | HtmlBlock;
export type BlockType = Block["type"];

export type Column = { id: string; w: number /* percent */; blocks: Block[] };
export type Section = {
  id: string;
  name?: string;
  bg: string | null; // section colour (full width, behind the content)
  contentBg: string | null; // content colour (null = the email's content background)
  bgImage: string | null;
  pad: Pad;
  valign: "top" | "middle" | "bottom";
  stack: Stack;
  gap: number; // space between columns, px
  visibility: Visibility;
  cols: Column[];
};

export type HeadingKey = "body" | "h1" | "h2" | "h3" | "h4";
export type GlobalStyles = {
  pageBg: string;
  contentBg: string;
  width: number;
  radius: number;
  marginTop: number;
  pad: Pad;
  border: Border | null;
  text: Record<HeadingKey, TextStyle>;
  link: { color: string; bold: boolean; italic: boolean; underline: boolean };
  mobile: { margin: number; sizes: Record<HeadingKey, number> };
};

export type EmailDoc = { v: 1; styles: GlobalStyles; sections: Section[]; subject?: string; preheader?: string };

/* ------------------------------------------------------------------ fonts */

/**
 * The font library (owner, 2026-11-09: "the most beautiful fonts for clothing stores … clean ones,
 * designed ones … make it wow"). Google Fonts (free to use in emails), grouped like a fashion
 * type kit. Apple Mail / iPhone, Samsung Mail and Outlook for Mac show them; Gmail and Outlook for
 * Windows ignore web fonts, so every font names a close fallback (same feel: serif, condensed …).
 */
export type FontCat = "Clean" | "Editorial serif" | "Display" | "Condensed" | "Script" | "Mono" | "Every inbox";
export type FontDef = { name: string; cat: FontCat; fallback: string; google?: string };

const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "Helvetica,Arial,sans-serif";
const NARROW = "'Arial Narrow','Helvetica Neue',Arial,sans-serif";
const IMPACT = "Impact,'Arial Narrow',Arial,sans-serif";
const SCRIPT = "'Brush Script MT','Segoe Script',Georgia,serif";
const MONO = "'Courier New',Courier,monospace";

export const FONTS: FontDef[] = [
  // Clean, modern sans (the everyday CARBON look)
  { name: "Montserrat", cat: "Clean", fallback: SANS, google: "Montserrat:ital,wght@0,400;0,700;1,400" },
  { name: "Jost", cat: "Clean", fallback: SANS, google: "Jost:ital,wght@0,400;0,700;1,400" },
  { name: "Josefin Sans", cat: "Clean", fallback: SANS, google: "Josefin+Sans:ital,wght@0,400;0,700;1,400" },
  { name: "Tenor Sans", cat: "Clean", fallback: SANS, google: "Tenor+Sans" },
  { name: "Poppins", cat: "Clean", fallback: SANS, google: "Poppins:ital,wght@0,400;0,700;1,400" },
  { name: "DM Sans", cat: "Clean", fallback: SANS, google: "DM+Sans:ital,wght@0,400;0,700;1,400" },
  { name: "Manrope", cat: "Clean", fallback: SANS, google: "Manrope:wght@400;700" },
  { name: "Outfit", cat: "Clean", fallback: SANS, google: "Outfit:wght@400;700" },
  { name: "Raleway", cat: "Clean", fallback: SANS, google: "Raleway:ital,wght@0,400;0,700;1,400" },
  { name: "Work Sans", cat: "Clean", fallback: SANS, google: "Work+Sans:ital,wght@0,400;0,700;1,400" },
  { name: "Lato", cat: "Clean", fallback: SANS, google: "Lato:ital,wght@0,400;0,700;1,400" },
  { name: "Karla", cat: "Clean", fallback: SANS, google: "Karla:ital,wght@0,400;0,700;1,400" },
  { name: "Figtree", cat: "Clean", fallback: SANS, google: "Figtree:wght@400;700" },
  { name: "Questrial", cat: "Clean", fallback: SANS, google: "Questrial" },
  { name: "Poiret One", cat: "Clean", fallback: SANS, google: "Poiret+One" },
  // Editorial serifs (luxury, magazine)
  { name: "Playfair Display", cat: "Editorial serif", fallback: SERIF, google: "Playfair+Display:ital,wght@0,400;0,700;1,400" },
  { name: "Bodoni Moda", cat: "Editorial serif", fallback: SERIF, google: "Bodoni+Moda:ital,wght@0,400;0,700;1,400" },
  { name: "Cormorant Garamond", cat: "Editorial serif", fallback: SERIF, google: "Cormorant+Garamond:ital,wght@0,400;0,700;1,400" },
  { name: "Instrument Serif", cat: "Editorial serif", fallback: SERIF, google: "Instrument+Serif:ital@0;1" },
  { name: "DM Serif Display", cat: "Editorial serif", fallback: SERIF, google: "DM+Serif+Display:ital@0;1" },
  { name: "Italiana", cat: "Editorial serif", fallback: SERIF, google: "Italiana" },
  { name: "Antic Didone", cat: "Editorial serif", fallback: SERIF, google: "Antic+Didone" },
  { name: "Prata", cat: "Editorial serif", fallback: SERIF, google: "Prata" },
  { name: "Gloock", cat: "Editorial serif", fallback: SERIF, google: "Gloock" },
  { name: "Fraunces", cat: "Editorial serif", fallback: SERIF, google: "Fraunces:ital,wght@0,400;0,700;1,400" },
  { name: "Libre Caslon Text", cat: "Editorial serif", fallback: SERIF, google: "Libre+Caslon+Text:ital,wght@0,400;0,700;1,400" },
  { name: "Marcellus", cat: "Editorial serif", fallback: SERIF, google: "Marcellus" },
  { name: "Cinzel", cat: "Editorial serif", fallback: SERIF, google: "Cinzel:wght@400;700" },
  // Display (big, bold statements)
  { name: "Abril Fatface", cat: "Display", fallback: SERIF, google: "Abril+Fatface" },
  { name: "Yeseva One", cat: "Display", fallback: SERIF, google: "Yeseva+One" },
  { name: "Archivo Black", cat: "Display", fallback: "'Arial Black',Arial,sans-serif", google: "Archivo+Black" },
  { name: "Syne", cat: "Display", fallback: SANS, google: "Syne:wght@400;700" },
  { name: "Unbounded", cat: "Display", fallback: "'Arial Black',Arial,sans-serif", google: "Unbounded:wght@400;700" },
  // Condensed (streetwear, sale banners)
  { name: "Bebas Neue", cat: "Condensed", fallback: IMPACT, google: "Bebas+Neue" },
  { name: "Anton", cat: "Condensed", fallback: IMPACT, google: "Anton" },
  { name: "Oswald", cat: "Condensed", fallback: NARROW, google: "Oswald:wght@400;700" },
  { name: "League Gothic", cat: "Condensed", fallback: IMPACT, google: "League+Gothic" },
  { name: "Big Shoulders Display", cat: "Condensed", fallback: NARROW, google: "Big+Shoulders+Display:wght@400;700" },
  { name: "Six Caps", cat: "Condensed", fallback: IMPACT, google: "Six+Caps" },
  // Script (signatures, accents)
  { name: "Great Vibes", cat: "Script", fallback: SCRIPT, google: "Great+Vibes" },
  { name: "Pinyon Script", cat: "Script", fallback: SCRIPT, google: "Pinyon+Script" },
  { name: "Parisienne", cat: "Script", fallback: SCRIPT, google: "Parisienne" },
  { name: "Allura", cat: "Script", fallback: SCRIPT, google: "Allura" },
  { name: "Italianno", cat: "Script", fallback: SCRIPT, google: "Italianno" },
  { name: "Mrs Saint Delafield", cat: "Script", fallback: SCRIPT, google: "Mrs+Saint+Delafield" },
  { name: "Monsieur La Doulaise", cat: "Script", fallback: SCRIPT, google: "Monsieur+La+Doulaise" },
  { name: "Sacramento", cat: "Script", fallback: SCRIPT, google: "Sacramento" },
  { name: "Dancing Script", cat: "Script", fallback: SCRIPT, google: "Dancing+Script:wght@400;700" },
  // Mono (labels, codes)
  { name: "Space Mono", cat: "Mono", fallback: MONO, google: "Space+Mono:ital,wght@0,400;0,700;1,400" },
  { name: "DM Mono", cat: "Mono", fallback: MONO, google: "DM+Mono:ital,wght@0,400;1,400" },
  // The same in every inbox (no web font needed)
  { name: "Helvetica", cat: "Every inbox", fallback: "Helvetica,Arial,sans-serif" },
  { name: "Arial", cat: "Every inbox", fallback: "Arial,Helvetica,sans-serif" },
  { name: "Arial Black", cat: "Every inbox", fallback: "'Arial Black',Arial,Helvetica,sans-serif" },
  { name: "Verdana", cat: "Every inbox", fallback: "Verdana,Geneva,sans-serif" },
  { name: "Tahoma", cat: "Every inbox", fallback: "Tahoma,Verdana,sans-serif" },
  { name: "Trebuchet MS", cat: "Every inbox", fallback: "'Trebuchet MS',Helvetica,sans-serif" },
  { name: "Lucida", cat: "Every inbox", fallback: "'Lucida Sans Unicode','Lucida Grande',sans-serif" },
  { name: "Georgia", cat: "Every inbox", fallback: "Georgia,'Times New Roman',serif" },
  { name: "Times New Roman", cat: "Every inbox", fallback: "'Times New Roman',Times,serif" },
  { name: "Courier New", cat: "Every inbox", fallback: "'Courier New',Courier,monospace" },
];
export const FONT_CATS: FontCat[] = ["Clean", "Editorial serif", "Display", "Condensed", "Script", "Mono", "Every inbox"];

/** CSS font-family for a font: the web font first, then its fallback. */
export function fontStack(name: string): string {
  const f = FONTS.find((x) => x.name === name);
  if (!f) return `${name.includes(" ") ? `'${name}'` : name},Helvetica,Arial,sans-serif`;
  return f.google ? `'${f.name}',${f.fallback}` : f.fallback;
}

/** Google Fonts stylesheet for one font (one request per font, so one bad font never breaks the rest). */
export const googleFontUrl = (f: FontDef) => `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;

/** The web fonts an email uses (its styles, blocks, and fonts picked in the text toolbar). */
export function fontsUsed(doc: unknown): FontDef[] {
  const json = JSON.stringify(doc);
  return FONTS.filter((f) => f.google && (json.includes(`"${f.name}"`) || json.includes(`'${f.name}'`) || json.includes(`&quot;${f.name}&quot;`) || json.includes(`\\"${f.name}\\"`) || json.includes(`font-family: ${f.name}`)));
}

/* --------------------------------------------------------------- defaults */

export const uid = () => Math.random().toString(36).slice(2, 10);
export const pad = (v: number, h: number = v): Pad => ({ t: v, r: h, b: v, l: h });
const font = (size: number, color = "#111111", family = "Helvetica", extra: Partial<Font> = {}): Font => ({ family, size, color, ls: 0, ...extra });

export const LOGO = {
  black: "https://wms.shopcarbon.com/email/carbon-logo-long-black.png",
  white: "https://wms.shopcarbon.com/email/carbon-logo-long-white.png",
};
export const SHOP_URL = "https://shopcarbon.com";
export const INSTAGRAM = "https://www.instagram.com/shopcarbon";

export function defaultStyles(): GlobalStyles {
  const t = (size: number, bold: boolean, lh = 1.3): TextStyle => ({ family: "Helvetica", size, color: "#111111", ls: 0, bold, lh, align: "left" });
  return {
    pageBg: "#F5F5F5",
    contentBg: "#FFFFFF",
    width: 600,
    radius: 0,
    marginTop: 32,
    pad: pad(0),
    border: null,
    text: { body: t(16, false, 1.5), h1: t(40, true, 1.1), h2: t(30, true, 1.15), h3: t(22, true, 1.2), h4: t(18, true, 1.3) },
    link: { color: "#111111", bold: false, italic: false, underline: true },
    mobile: { margin: 0, sizes: { body: 15, h1: 32, h2: 26, h3: 20, h4: 17 } },
  };
}

const base = (p: Pad = pad(9, 18)) => ({ id: uid(), bg: null, pad: p, fullMobile: false, visibility: "all" as Visibility });

export function newBlock(type: BlockType): Block {
  switch (type) {
    case "text":
      return { ...base(), type, html: "<p>This is a text block. Double-click to edit it.</p>", areaPad: pad(0), areaBg: null, border: null };
    case "image":
      return { ...base(pad(0)), type, src: null, alt: "", href: "", width: null, natW: null, natH: null, align: "center", fill: true, fillMobile: true, radius: 0, areaBg: null, border: null };
    case "split":
      return {
        ...base(),
        type,
        cells: [
          { kind: "image", src: null, alt: "", href: "" },
          { kind: "text", html: "<h3>A headline</h3><p>This is the second column. Double-click to edit it.</p>" },
        ],
        widths: [50, 50],
        spacing: 24,
        stack: "left-first",
        valign: "middle",
      };
    case "button":
      return {
        ...base(),
        type,
        text: "SHOP NOW",
        href: SHOP_URL,
        font: font(15, "#FFFFFF", "Helvetica", { bold: true, ls: 2 }),
        color: "#111111",
        radius: 0,
        full: false,
        align: "center",
        btnPad: { v: 16, h: 40 },
        border: null,
        shadow: null,
      };
    case "header":
      return {
        ...base(pad(18, 18)),
        type,
        logo: LOGO.black,
        logoWidth: 140,
        logoHref: SHOP_URL,
        layout: "stacked",
        mobileLayout: "stack",
        links: [
          { id: uid(), text: "WOMEN", href: "https://shopcarbon.com/collections/women" },
          { id: uid(), text: "MEN", href: "https://shopcarbon.com/collections/men" },
          { id: uid(), text: "NEW IN", href: "https://shopcarbon.com/collections/new-arrivals" },
        ],
        linkFont: font(12, "#111111", "Helvetica", { bold: true, ls: 2 }),
        linkPad: { v: 8, h: 12 },
        align: "center",
      };
    case "divider":
      return { ...base(pad(18, 18)), type, style: "solid", width: 1, color: "#DDDDDD", lineWidth: 100 };
    case "spacer":
      return { ...base(pad(0)), type, height: 24 };
    case "social":
      return {
        ...base(pad(12, 18)),
        type,
        items: [
          { id: uid(), net: "instagram", href: INSTAGRAM, label: "Instagram" },
          { id: uid(), net: "facebook", href: "https://www.facebook.com/shopcarbon", label: "Facebook" },
          { id: uid(), net: "tiktok", href: "https://www.tiktok.com/@carbonjeans", label: "TikTok" },
        ],
        size: "m",
        color: "black",
        align: "center",
        spacing: 10,
        showLabels: false,
        labelFont: font(11, "#555555", "Helvetica"),
      };
    case "product":
      return {
        ...base(),
        type,
        source: "dynamic",
        feed: "newest",
        startAt: 1,
        items: [],
        perRow: 3,
        rows: 1,
        orientation: "vertical",
        align: "center",
        gap: 12,
        imgRatio: "4:5",
        showName: true,
        showPrice: true,
        showCompare: true,
        showButton: true,
        buttonText: "Shop now",
        nameFont: font(14, "#111111"),
        priceFont: font(14, "#111111", "Helvetica", { bold: true }),
        btnFont: font(12, "#FFFFFF", "Helvetica", { bold: true, ls: 1 }),
        btnColor: "#111111",
        btnRadius: 0,
        btnPad: { v: 10, h: 18 },
        border: null,
      };
    case "code":
      return {
        ...base(pad(24, 24)),
        type,
        title: "Your code",
        note: "{{offer_amount}} off one order. Ends {{offer_ends}}.",
        codeFont: font(22, "#111111", "Courier New", { bold: true, ls: 3 }),
        boxBg: "#FFFFFF",
        boxBorder: { style: "dashed", width: 2, color: "#111111" },
        titleFont: font(12, "#555555", "Helvetica", { bold: true, ls: 2 }),
        noteFont: font(14, "#333333"),
        align: "center",
        button: true,
        buttonText: "USE MY CODE",
        btnColor: "#111111",
        btnFont: font(13, "#FFFFFF", "Helvetica", { bold: true, ls: 2 }),
      };
    case "video":
      return { ...base(pad(0)), type, thumb: null, href: "", alt: "Watch the video", align: "center", radius: 0 };
    case "html":
      return { ...base(pad(0)), type, code: '<p style="margin:0;font-family:Helvetica,Arial,sans-serif;font-size:16px;"><strong>HTML block</strong></p>' };
  }
}

export const LAYOUTS: Record<number, number[][]> = {
  1: [[100]],
  2: [
    [50, 50],
    [33, 67],
    [67, 33],
    [25, 75],
    [75, 25],
  ],
  3: [
    [33.33, 33.33, 33.34],
    [50, 25, 25],
    [25, 50, 25],
    [25, 25, 50],
  ],
  4: [[25, 25, 25, 25]],
};

export function newSection(widths: number[] = [100], blocks: Block[][] = []): Section {
  return {
    id: uid(),
    bg: null,
    contentBg: null,
    bgImage: null,
    pad: pad(0),
    valign: "top",
    stack: "left-first",
    gap: 0,
    visibility: "all",
    cols: widths.map((w, i) => ({ id: uid(), w, blocks: blocks[i] ?? [] })),
  };
}

export function blankDoc(): EmailDoc {
  return { v: 1, styles: defaultStyles(), sections: [newSection([100], [[newBlock("header")]]), newSection([100], [[]])] };
}

/** A copy with fresh ids (duplicate, insert pre-built). */
export function cloneBlock<T extends Block>(b: T): T {
  const c = JSON.parse(JSON.stringify(b)) as T;
  c.id = uid();
  if (c.type === "header") c.links = c.links.map((l) => ({ ...l, id: uid() }));
  if (c.type === "social") c.items = c.items.map((l) => ({ ...l, id: uid() }));
  return c;
}
export function cloneSection(s: Section): Section {
  const c = JSON.parse(JSON.stringify(s)) as Section;
  c.id = uid();
  c.cols = c.cols.map((col) => ({ ...col, id: uid(), blocks: col.blocks.map((b) => cloneBlock(b)) }));
  return c;
}

export const BLOCK_LABEL: Record<BlockType, string> = {
  text: "Text",
  image: "Image",
  split: "Split",
  button: "Button",
  header: "Header bar",
  divider: "Divider",
  spacer: "Spacer",
  social: "Social links",
  product: "Product",
  code: "Code",
  video: "Video",
  html: "HTML",
};

/** Basic check that a document from the database or the browser is an email doc (the server re-renders it). */
export function isDoc(x: unknown): x is EmailDoc {
  const d = x as EmailDoc;
  return !!d && d.v === 1 && !!d.styles && Array.isArray(d.sections) && d.sections.every((s) => Array.isArray(s?.cols) && s.cols.every((c) => Array.isArray(c?.blocks)));
}

/* --------------------------------------------------------------- brand kit */

/**
 * The store's brand kit (owner, 2026-11-09, like Klaviyo's): the email styles new blank emails
 * start with (fonts, text colours, link and button look, page and content colours, width) and the
 * brand colours offered in every colour picker.
 */
export type BrandKit = { styles: GlobalStyles; colors: string[] };

const HEX6 = /^#[0-9A-Fa-f]{6}$/;
export function isKit(x: unknown): x is BrandKit {
  const k = x as BrandKit;
  return !!k && !!k.styles && typeof k.styles === "object" && !!k.styles.text && Array.isArray(k.colors) && k.colors.length <= 24 && k.colors.every((c) => typeof c === "string" && HEX6.test(c));
}

/** The colours an email uses (for "Save as brand kit": a starting palette). */
export function docColors(doc: EmailDoc): string[] {
  const seen = new Map<string, number>();
  for (const m of JSON.stringify(doc).matchAll(/#[0-9A-Fa-f]{6}\b/g)) {
    const c = m[0].toUpperCase();
    seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([c]) => c);
}
