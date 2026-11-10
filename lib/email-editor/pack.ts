/**
 * CarbonWMS Email — the CARBON template pack (owner, 2026-11-10): 10 starters built from the
 * pack's spec (Night Shift, Silhouette, The Edit, Monument, Coordinates, Brutal Grid, Red Alert,
 * Teaser, Cut & Paste, Quiet). Every part is a normal editor block, so sections can be reordered,
 * added or removed and every word, picture, link, price and colour edited. The hero of each is a
 * "Hero picture" block (lib/email-editor/heroes.ts), drawn into one image on the server.
 *
 * Owner's rules applied to the pack's sample copy: the brand is "CARBON" (never "CARBON Jeans"),
 * no country of origin, Instagram is @shopcarbon, the crew/rewards link is the Member Club.
 * Products come from the live catalog (newest in stock), not the sample names.
 */
import { heroDefaults, heroInfo, BONE, INK, LIME, ORANGE, RED, STEEL, PACK_BASE, type HeroLayout } from "./heroes";
import { PACK_EMAILS, type PackPlanRow } from "./pack-emails.data";
import { LOGO, defaultStyles, newBlock, newSection, pad, type Block, type EmailDoc, type GlobalStyles, type Section } from "./types";

const SHOP = "https://shopcarbon.com";
const NEW_IN = "https://shopcarbon.com/collections/new-arrivals";
const CLUB = "https://shopcarbon.com/pages/member-club";
const IG = "https://www.instagram.com/shopcarbon";
const MAPS = "https://www.google.com/maps/dir/?api=1&destination=6250+Edgewater+Drive%2C+Suite+100%2C+Orlando%2C+FL+32810";
const BODY_FONT = "Space Grotesk";
const DISPLAY = "Anton";

type Theme = { bg: string; fg: string };

function styles(t: Theme): GlobalStyles {
  const s = defaultStyles();
  s.pageBg = t.bg;
  s.contentBg = t.bg;
  s.pad = pad(0);
  s.marginTop = 0;
  s.text.body = { ...s.text.body, family: BODY_FONT, size: 17, lh: 1.6, color: t.fg, ls: 0 };
  s.text.h1 = { ...s.text.h1, family: DISPLAY, size: 64, lh: 1, color: t.fg, bold: false, ls: 0 };
  s.text.h2 = { ...s.text.h2, family: DISPLAY, size: 40, lh: 1.05, color: t.fg, bold: false, ls: 0 };
  s.text.h3 = { ...s.text.h3, family: DISPLAY, size: 30, lh: 1.05, color: t.fg, bold: false, ls: 0 };
  s.text.h4 = { ...s.text.h4, family: BODY_FONT, size: 15, lh: 1.4, color: t.fg, bold: true, ls: 1 };
  s.link = { ...s.link, color: t.fg };
  s.mobile = { ...s.mobile, margin: 0, sizes: { ...s.mobile.sizes, h1: 56, h2: 36, body: 16 } };
  return s;
}

/** Capitals, but personal tags ({{first_name|there}}) stay as they are. */
const upper = (s: string) => s.replace(/(\{\{[^}]*\}\})|([^{]+|\{)/g, (_m, tag: string | undefined, rest: string | undefined) => tag ?? (rest ?? "").toUpperCase());

const sec = (blocks: Block[], bg: string, p = pad(0)): Section => ({ ...newSection([100], [blocks]), bg, contentBg: bg, pad: p });

function text(html: string, p = pad(0, 30)): Block {
  const b = newBlock("text");
  if (b.type === "text") {
    b.html = html;
    b.pad = p;
  }
  return b;
}

/** Kicker: capitals by CSS, so a personal tag like {{first_name}} keeps working. */
const kickerP = (k: string, color: string, align = "left") =>
  `<p style="text-align:${align};font-family:'${BODY_FONT}';font-size:13px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:${color};">${k}</p>`;

/** TextBlock: kicker, headline (two lines), body. */
function textBlock(o: { kicker?: string; kickerColor: string; headline: string; body: string; fg: string; align?: "left" | "center"; h1?: number }): Block {
  const al = o.align ?? "left";
  return text(
    `${o.kicker ? kickerP(o.kicker, o.kickerColor, al) : ""}<h1 style="text-align:${al};font-family:'${DISPLAY}';font-size:${o.h1 ?? 64}px;line-height:1;color:${o.fg};">${o.headline}</h1><p style="text-align:${al};font-family:'${BODY_FONT}';font-size:17px;line-height:1.6;color:${o.fg};">${o.body}</p>`,
    pad(40, 30),
  );
}

/** Square, 60 px, no shadow; outline = 3 px border. */
function button(label: string, href: string, bg: string, fg: string, o: { align?: "left" | "center"; outline?: string } = {}): Block {
  const b = newBlock("button");
  if (b.type === "button") {
    b.text = upper(label);
    b.href = href;
    b.color = bg; // an outline button sits on the page colour
    b.font = { ...b.font, family: BODY_FONT, size: 16, color: fg, bold: true, ls: 2 };
    b.radius = 0;
    b.btnPad = { v: o.outline ? 17 : 20, h: 40 };
    b.border = o.outline ? { style: "solid", width: 3, color: o.outline } : null;
    b.shadow = null;
    b.align = o.align ?? "left";
    b.full = false;
    b.pad = pad(4, 30);
    b.pad.b = 44;
  }
  return b;
}

function hero(layout: HeroLayout, over: Partial<ReturnType<typeof heroDefaults>> = {}, href = SHOP): Block {
  const b = newBlock("hero");
  if (b.type === "hero") Object.assign(b, heroDefaults(layout), over, { href, pad: pad(0), fullMobile: true });
  return b;
}

/** LogoBar: the real CARBON logo left, a label right. */
function logoBar(bg: string, label: string, labelColor: string, darkLogo = false): Section {
  const logo = newBlock("image");
  if (logo.type === "image") {
    logo.src = darkLogo ? LOGO.black : LOGO.white;
    logo.alt = "CARBON";
    logo.href = SHOP;
    logo.width = 130;
    logo.align = "left";
    logo.pad = pad(0);
  }
  const s = newSection([50, 50], [[logo], [text(`<p style="text-align:right;font-family:'${BODY_FONT}';font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${labelColor};">${label}</p>`, pad(0))]]);
  return { ...s, bg, contentBg: bg, pad: pad(22, 30), stack: "none", valign: "middle", name: "Logo bar" };
}

/** ProductGrid: the newest in-stock pieces, 2 per row (1 on phones). */
function products(n: number, fg: string, o: { border?: string; sale?: string } = {}): Block {
  const p = newBlock("product");
  if (p.type === "product") {
    p.source = "dynamic";
    p.feed = "newest";
    p.perRow = 2;
    p.rows = Math.ceil(n / 2);
    p.imgRatio = "4:5";
    p.align = "left";
    p.gap = 20;
    p.showButton = false;
    p.showCompare = !!o.sale;
    p.nameFont = { ...p.nameFont, family: BODY_FONT, size: 15, bold: true, ls: 1, color: fg };
    p.priceFont = { ...p.priceFont, family: BODY_FONT, size: 15, bold: !!o.sale, ls: 0, color: o.sale ?? fg };
    p.border = o.border ? { style: "solid", width: 3, color: o.border } : null;
    p.pad = pad(8, 30);
    p.pad.b = 40;
  }
  return p;
}

/** SplitFeature: a photo beside a kicker, headline and line (flip = photo on the right). */
function split(kicker: string, accent: string, headline: string, line: string, fg: string, bg: string, flip = false): Section {
  const im = newBlock("image");
  if (im.type === "image") {
    im.alt = headline;
    im.fill = true;
    im.pad = pad(0);
  }
  const tx = text(`${kickerP(kicker, accent)}<h2 style="font-family:'${DISPLAY}';font-size:36px;line-height:1.05;color:${fg};">${upper(headline)}</h2><p style="font-family:'${BODY_FONT}';font-size:16px;line-height:1.6;color:${fg};">${line}</p>`, pad(20, 24));
  const s = newSection([50, 50], flip ? [[tx], [im]] : [[im], [tx]]);
  return { ...s, bg, contentBg: bg, pad: pad(0), gap: 0, valign: "middle", stack: flip ? "right-first" : "left-first", name: "Split feature" };
}

/** Ticker: words split with //, one line. */
const ticker = (words: string, bg: string, fg: string): Section =>
  sec([text(`<p style="text-align:center;font-family:'${BODY_FONT}';font-size:14px;font-weight:700;letter-spacing:3px;color:${fg};white-space:nowrap;overflow:hidden;">${upper(words)}</p>`, pad(14, 10))], bg);

/** ImageStrip: a full-width element (hazard tape, torn edge). */
function strip(file: string, bg: string): Section {
  const im = newBlock("image");
  if (im.type === "image") {
    im.src = `${PACK_BASE}/${file}.png`;
    im.alt = "";
    im.fill = true;
    im.fillMobile = true;
    im.natW = 1200;
    im.natH = file.startsWith("torn") ? 68 : 56;
    im.pad = pad(0);
  }
  return sec([im], bg);
}

const quote = (q: string, who: string, fg: string): Block =>
  text(
    `<p style="font-family:'${BODY_FONT}';font-size:22px;line-height:1.45;font-weight:500;color:${fg};">“${q}”</p><p style="font-family:'${BODY_FONT}';font-size:13px;font-weight:700;letter-spacing:3px;color:${fg};">— ${upper(who)}</p>`,
    pad(36, 30),
  );

/** Footer: accent rule, logo, links. The unsubscribe link and address are added to every email when it is sent. */
function footer(bg: string, fg: string, accent: string, darkLogo = false): Section[] {
  const rule = newBlock("divider");
  if (rule.type === "divider") {
    rule.color = accent;
    rule.width = 4;
    rule.lineWidth = 100;
    rule.pad = pad(0, 30);
  }
  const logo = newBlock("image");
  if (logo.type === "image") {
    logo.src = darkLogo ? LOGO.black : LOGO.white;
    logo.alt = "CARBON";
    logo.href = SHOP;
    logo.width = 110;
    logo.align = "left";
    logo.pad = P(26, 30, 0, 30);
  }
  const a = (t: string, h: string) => `<a href="${h}" style="color:${fg};text-decoration:none;">${t}</a>`;
  return [
    sec(
      [
        rule,
        logo,
        text(`<p style="font-family:'${BODY_FONT}';font-size:14px;font-weight:700;letter-spacing:2px;color:${fg};">${a("INSTAGRAM", IG)}&nbsp;&nbsp;/&nbsp;&nbsp;${a("SHOP", SHOP)}&nbsp;&nbsp;/&nbsp;&nbsp;${a("MEMBER CLUB", CLUB)}</p>`, pad(14, 30)),
      ],
      bg,
      P(0, 0, 12, 0),
    ),
  ];
}

/** InfoCard: rows of label / value on steel, with a barcode. */
function infoCard(accent: string): Section {
  const rows = (label: string, value: string) =>
    `<p style="font-family:'${BODY_FONT}';font-size:13px;font-weight:700;letter-spacing:3px;color:${accent};">${label}</p><p style="font-family:'${BODY_FONT}';font-size:17px;line-height:1.5;color:${BONE};">${value}</p>`;
  const card = text(`${rows("ADDRESS", "6250 Edgewater Drive, Suite 100<br>Orlando, FL 32810")}${rows("HOURS", "Mon–Tue 12–7 PM · Thu–Sat 12–7 PM<br>Wed &amp; Sun closed")}`, pad(0));
  if (card.type === "text") {
    card.areaBg = STEEL;
    card.areaPad = pad(22, 24);
  }
  const bar = newBlock("image");
  if (bar.type === "image") {
    bar.src = `${PACK_BASE}/barcode-bone.png`;
    bar.alt = "";
    bar.width = 160;
    bar.natW = 440;
    bar.natH = 112;
    bar.align = "right";
    bar.pad = P(10, 0, 0, 0);
  }
  return sec([card, bar], INK, P(0, 30, 28, 30));
}

/** Countdown: the live countdown picture (ends a week from when the email is made; set the date in the editor). */
function countdown(cellBg = INK, fg = BONE, pageBg: string | null = null): Block {
  const b = newBlock("countdown");
  if (b.type === "countdown") {
    b.cellBg = cellBg;
    b.fg = fg;
    b.pageBg = pageBg;
    b.pad = P(28, 30, 0, 30);
  }
  return b;
}

/** Padding top, right, bottom, left. */
const P = (t: number, r: number, b: number, l: number) => ({ t, r, b, l });

const doc = (t: Theme, sections: Section[]): EmailDoc => ({ v: 1, styles: styles(t), sections });
const dark: Theme = { bg: INK, fg: BONE };

/* ---------------------------------------------------------------- the 10 */

export type PackStarter = { id: string; name: string; description: string; make: () => EmailDoc };

export const PACK: PackStarter[] = [
  {
    id: "pack-night-shift",
    name: "Night Shift",
    description: "Lookbook launch: photo collage hero, two looks, orange ticker.",
    make: () =>
      doc(dark, [
        logoBar(INK, "Lookbook / Vol.01", ORANGE),
        sec([hero("night-shift", {}, NEW_IN)], INK),
        sec([textBlock({ kicker: "{{first_name|Hey}}, the city doesn't sleep.", kickerColor: ORANGE, headline: "SIX LOOKS.<br>ZERO DAYLIGHT.", body: "Shot on the parking decks of downtown Orlando between 1 and 4 AM. Raw denim, heavy cotton, hardware that catches the streetlight.", fg: BONE }), button("View the lookbook →", NEW_IN, ORANGE, INK)], INK),
        split("Look 03", ORANGE, "Raw on raw", "Our raw straight with the night jacket. Double denim, done right.", BONE, INK),
        split("Look 05", ORANGE, "Hardware", "Gunmetal rivets. Bar-tacked stress points. Built for nights like this.", BONE, INK, true),
        ticker("Night Shift  //  FW26  //  Orlando  //  Night Shift  //  FW26", ORANGE, INK),
        ...footer(INK, BONE, ORANGE),
      ]),
  },
  {
    id: "pack-silhouette",
    name: "Silhouette",
    description: "New collection: one black-and-white photo, a giant word, two products.",
    make: () =>
      doc(dark, [
        logoBar(INK, "FW26", ORANGE),
        sec([hero("silhouette", {}, NEW_IN)], INK),
        sec([textBlock({ kicker: "The Silhouette Collection", kickerColor: ORANGE, headline: "SHAPE IS<br>EVERYTHING.", body: "Cut sharp, hung heavy. New pieces built around one idea: the outline you leave behind.", fg: BONE, align: "center" }), button("Shop Silhouette →", NEW_IN, BONE, INK, { align: "center" })], INK),
        sec([products(2, BONE)], INK),
        ...footer(INK, BONE, ORANGE),
      ]),
  },
  {
    id: "pack-editorial",
    name: "The Edit",
    description: "Editorial story: word behind the model, a wide photo, a quote, two products.",
    make: () =>
      doc(dark, [
        logoBar(INK, "The Edit / 07", BONE),
        sec([hero("editorial", {}, SHOP)], INK),
        sec([textBlock({ kicker: "Feature", kickerColor: ORANGE, headline: "NO FILTER.<br>NO FAKE FADES.", body: "We sat down with three Orlando creatives who wear CARBON every day: skate, studio, and the night shift. This is how the denim looks after 90 days of real life.", fg: BONE }), button("Read the story →", SHOP, INK, BONE, { outline: BONE })], INK),
        (() => {
          const im = newBlock("image");
          if (im.type === "image") {
            im.alt = "A look in the street";
            im.fill = true;
            im.pad = pad(0);
          }
          return sec([im], INK);
        })(),
        sec([(() => { const q = quote("I don't baby my jeans. They're supposed to look like I lived in them.", "Marcus, skater, Orlando", BONE); if (q.type === "text") { q.areaBg = STEEL; q.areaPad = pad(24, 24); q.pad = pad(0, 30); } return q; })()], INK, pad(30, 0)),
        sec([products(2, BONE)], INK),
        ...footer(INK, BONE, ORANGE),
      ]),
  },
  {
    id: "pack-monument",
    name: "Monument",
    description: "Product drop: one phrase stacked five times, monochrome, four products.",
    make: () =>
      doc(dark, [
        logoBar(INK, "Drop 014", BONE),
        sec([hero("monument", {}, NEW_IN)], INK),
        ticker("14 oz selvedge  //  Made to fade  //  Limited run", BONE, INK),
        sec([textBlock({ kicker: "Drop 014", kickerColor: BONE, headline: "BUILT HEAVY.<br>AGES LOUD.", body: "14 oz selvedge, unwashed and unsanforized. Wear it hard for six months and it becomes yours alone.", fg: BONE }), button("Shop Drop 014 →", NEW_IN, BONE, INK)], INK),
        sec([products(4, BONE)], INK),
        ...footer(INK, BONE, BONE),
      ]),
  },
  {
    id: "pack-coordinates",
    name: "Coordinates",
    description: "Store / showroom / event: GPS bar, city name, address and hours card.",
    make: () =>
      doc(dark, [
        logoBar(INK, "Orlando, FL", BONE),
        sec([hero("coordinates", {}, MAPS)], INK),
        sec([textBlock({ kicker: "You're invited", kickerColor: RED, headline: "COME<br>THROUGH.", body: "Try the full line in person, get fitted for raw denim, and grab showroom-only pieces.", fg: BONE })], INK),
        infoCard(RED),
        sec([button("Get directions →", MAPS, RED, BONE)], INK),
        ...footer(INK, BONE, RED),
      ]),
  },
  {
    id: "pack-brutal-grid",
    name: "Brutal Grid",
    description: "Sale / promo code: lime grid hero, hazard tape, four products on sale.",
    make: () =>
      doc(dark, [
        logoBar(INK, "72 hrs only", LIME),
        strip("hazard-lime", INK),
        sec([hero("brutal-grid", {}, SHOP)], INK),
        sec([textBlock({ kicker: "Your code: {{code}}", kickerColor: LIME, headline: "EVERYTHING<br>ON THE GRID.", body: "{{offer_amount}} off with your own code, until {{offer_ends}}.", fg: BONE }), button("Shop the sale →", "{{code_url}}", LIME, INK)], INK),
        sec([products(4, BONE, { border: LIME, sale: LIME })], INK),
        strip("hazard-lime", INK),
        ...footer(INK, BONE, LIME),
      ]),
  },
  {
    id: "pack-red-alert",
    name: "Red Alert",
    description: "Drop countdown / early access: red page, countdown, member early access.",
    make: () =>
      doc({ bg: RED, fg: INK }, [
        logoBar(RED, "Friday 12PM ET", INK, true),
        sec([hero("red-alert", {}, NEW_IN)], RED),
        sec([countdown(INK, BONE, RED)], RED),
        sec(
          [
            textBlock({ kicker: "Limited run", kickerColor: INK, headline: "DON'T<br>SLEEP.", body: "The night jacket returns in black-on-black. When it's gone, it's gone. Member Club gets early access.", fg: INK, align: "center" }),
            button("Get early access →", CLUB, INK, BONE, { align: "center" }),
          ],
          RED,
        ),
        ...footer(INK, BONE, RED),
      ]),
  },
  {
    id: "pack-teaser",
    name: "Teaser",
    description: "Coming soon / waitlist: blurred orange hero, one giant word, loading ticker.",
    make: () =>
      doc({ bg: ORANGE, fg: INK }, [
        logoBar(ORANGE, "Classified", INK, true),
        sec([hero("teaser", {}, IG)], ORANGE),
        sec(
          [
            textBlock({ kicker: "Date: classified", kickerColor: INK, headline: "YOU'LL KNOW<br>WHEN YOU KNOW.", body: "We can't say what it is yet. We can say you'll want to be first. Follow us and you'll see it the second it goes live.", fg: INK, align: "center" }),
            button("Follow @shopcarbon →", IG, INK, ORANGE, { align: "center" }),
          ],
          ORANGE,
        ),
        ticker("Loading  //  Loading  //  Loading  //  Loading", INK, ORANGE),
        ...footer(INK, BONE, ORANGE),
      ]),
  },
  {
    id: "pack-cut-paste",
    name: "Cut & Paste",
    description: "Monthly zine / newsletter: collage hero, torn paper, two features, hazard tape.",
    make: () =>
      doc(dark, [
        logoBar(INK, "Street Issue / 03", ORANGE),
        sec([hero("cut-paste", {}, SHOP)], INK),
        sec([textBlock({ kicker: "This month", kickerColor: ORANGE, headline: "WHAT'S ON<br>THE WALL.", body: "Our monthly zine: new pieces, a playlist from the warehouse, and the best fits you tagged @shopcarbon this month.", fg: INK })], BONE),
        strip("torn-ink-top", BONE),
        split("01 / Fit of the month", ORANGE, "Tagged by you", "Tag your CARBON fit @shopcarbon for a chance to be featured.", BONE, INK),
        split("02 / Warehouse tape", ORANGE, "Now playing", "The playlist we pack orders to.", BONE, INK, true),
        strip("hazard-orange", INK),
        sec([button("Read the full issue →", SHOP, ORANGE, INK)], INK, P(28, 0, 0, 0)),
        ...footer(INK, BONE, ORANGE),
      ]),
  },
  {
    id: "pack-quiet",
    name: "Quiet",
    description: "Restock / essentials / after-purchase: the one light template, calm and roomy.",
    make: () =>
      doc({ bg: BONE, fg: INK }, [
        logoBar(BONE, "Restock", INK, true),
        sec([hero("quiet", {}, NEW_IN)], BONE),
        sec([textBlock({ kicker: "Back in every size", kickerColor: INK, headline: "LESS NOISE.<br>BETTER BASICS.", body: "The pieces you wear four days a week. Heavy box tee, raw straight, utility cargo: restocked in every size.", fg: INK, align: "center", h1: 56 }), button("Shop essentials →", NEW_IN, INK, BONE, { align: "center" })], BONE),
        sec([products(4, INK)], BONE),
        ...footer(BONE, INK, INK, true),
      ]),
  },
];

/* --------------------------------------------- the pack's 11–70 (converted from its references) */

type PlanRow = PackPlanRow;

const isLight = (c: string) => {
  const n = parseInt(c.replace("#", ""), 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) >= 140;
};

function fromRow(r: PlanRow): Section[] {
  const P4 = (p: readonly number[]) => P(p[0], p[1], p[2], p[3]);
  switch (r.t) {
    case "logo":
      return [logoBar(r.bg, r.label, r.labelColor, r.dark)];
    case "hero":
      return [sec([hero(r.layout as HeroLayout, {}, r.href)], INK)].map((s) => {
        const b = s.cols[0].blocks[0];
        if (b.type === "hero") b.alt = r.alt;
        return { ...s, bg: heroInfo(r.layout as HeroLayout).bg, contentBg: heroInfo(r.layout as HeroLayout).bg };
      });
    case "text": {
      const t = text(r.html, pad(0));
      return [sec([t], r.bg, P4(r.pad))];
    }
    case "button": {
      const b = button(r.label, r.href, r.outline ? r.bg : r.color, r.fg, { align: r.align === "center" ? "center" : "left", outline: r.outline ?? undefined });
      b.pad = pad(0);
      return [sec([b], r.bg, P4(r.pad))];
    }
    case "products": {
      const p = products(r.n, r.fg, { border: r.border ?? undefined, sale: r.sale ?? undefined });
      if (p.type === "product") {
        if (r.cart) p.feed = "cart";
        if (r.list) {
          p.perRow = 1;
          p.rows = r.n;
          p.orientation = "image-left";
          p.imgRatio = "1:1";
        }
        p.pad = pad(0);
      }
      return [sec([p], r.bg, P4(r.pad))];
    }
    case "image": {
      const im = newBlock("image");
      if (im.type === "image") {
        im.src = r.src;
        im.alt = r.alt;
        im.fill = true;
        im.fillMobile = true;
        im.pad = pad(0);
      }
      return [sec([im], r.bg, P4(r.pad))];
    }
    case "split": {
      const im = newBlock("image");
      if (im.type === "image") {
        im.alt = r.alt;
        im.fill = true;
        im.pad = pad(0);
      }
      const tx = text(r.html, pad(20, 24));
      const s = newSection([50, 50], r.flip ? [[tx], [im]] : [[im], [tx]]);
      return [{ ...s, bg: r.bg, contentBg: r.bg, pad: pad(0), gap: 0, valign: "middle", stack: r.flip ? "right-first" : "left-first", name: "Split feature" }];
    }
    case "countdown": {
      const c = countdown(r.cell, r.fg, r.bg);
      c.pad = pad(0);
      return [sec([c], r.bg, P4(r.pad))];
    }
    case "footer":
      return footer(r.bg, r.fg, r.accent, r.dark);
  }
}

const SERIES = (n: number): PackGroup => (n <= 30 ? "pack-seasonal" : n <= 40 ? "pack-studio" : "pack-bright");
export type PackGroup = "pack" | "pack-seasonal" | "pack-studio" | "pack-bright";

/** 11–70 as starters, each a fresh editable email. */
export const PACK_MORE: (PackStarter & { group: PackGroup; preheader: string })[] = PACK_EMAILS.map((e) => ({
  id: `pack-${e.id}`,
  name: `${e.n} · ${e.name}`,
  description: e.description,
  preheader: e.preheader,
  group: SERIES(e.n),
  make: () => doc({ bg: e.pageBg, fg: isLight(e.pageBg) ? INK : BONE }, e.plan.flatMap(fromRow)),
}));
